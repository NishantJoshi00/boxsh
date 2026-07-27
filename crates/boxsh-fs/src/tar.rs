//! TAR archive encoding and decoding — the Rust twin of tar.ts.
//!
//! Plain ustar: names over 100 bytes split into prefix/name at a slash
//! boundary, mtimes stored at second precision, directories as type '5'
//! entries. Import merges into the backend (overwrite; missing parents
//! created), stamping mtimes with the backend clock exactly like the
//! TypeScript implementation. Links and other entry types are skipped.

use crate::{Backend, Kind, Result, split_parent};

const BLOCK: usize = 512;

fn set_octal(h: &mut [u8], at: usize, width: usize, n: u64) {
    let s = format!("{n:0>w$o}\0", w = width - 1);
    h[at..at + width].copy_from_slice(&s.as_bytes()[..width]);
}

fn header(name: &str, size: u64, mtime_ms: u64, is_dir: bool) -> [u8; BLOCK] {
    let mut h = [0u8; BLOCK];
    let full = if is_dir {
        format!("{name}/")
    } else {
        name.to_string()
    };
    let fb = full.as_bytes();
    if fb.len() > 100 {
        // Split into prefix/name at a slash boundary (mirrors tar.ts,
        // including its handling of names with no early slash).
        let cut = match fb[..fb.len().min(101)].iter().rposition(|&b| b == b'/') {
            Some(0) | None => 100,
            Some(i) => i,
        };
        let tail = &fb[(cut + 1).min(fb.len())..];
        let tail = &tail[..tail.len().min(100)];
        h[..tail.len()].copy_from_slice(tail);
        let pre = &fb[..cut.min(155)];
        h[345..345 + pre.len()].copy_from_slice(pre);
    } else {
        h[..fb.len()].copy_from_slice(fb);
    }
    set_octal(&mut h, 100, 8, if is_dir { 0o755 } else { 0o644 });
    set_octal(&mut h, 108, 8, 0); // uid
    set_octal(&mut h, 116, 8, 0); // gid
    set_octal(&mut h, 124, 12, if is_dir { 0 } else { size });
    set_octal(&mut h, 136, 12, mtime_ms / 1000);
    h[148..156].copy_from_slice(b"        "); // checksum placeholder
    h[156] = if is_dir { b'5' } else { b'0' };
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    let cs = format!("{sum:0>6o}\0 ");
    h[148..156].copy_from_slice(cs.as_bytes());
    h
}

/// The whole tree as a tar archive.
pub fn export<B: Backend + ?Sized>(backend: &mut B) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    walk(backend, "", &mut out)?;
    out.resize(out.len() + BLOCK * 2, 0); // end-of-archive
    Ok(out)
}

fn walk<B: Backend + ?Sized>(backend: &mut B, dir: &str, out: &mut Vec<u8>) -> Result<()> {
    let mut names = backend.list(dir)?;
    names.sort();
    for name in names {
        let full = if dir.is_empty() {
            name
        } else {
            format!("{dir}/{name}")
        };
        let Some(e) = backend.entry(&full)? else {
            continue;
        };
        match e.kind {
            Kind::Dir => {
                out.extend_from_slice(&header(&full, 0, e.mtime, true));
                walk(backend, &full, out)?;
            }
            Kind::File => {
                let data = backend.read(&full)?;
                out.extend_from_slice(&header(&full, data.len() as u64, e.mtime, false));
                out.extend_from_slice(&data);
                let pad = (BLOCK - data.len() % BLOCK) % BLOCK;
                out.resize(out.len() + pad, 0);
            }
        }
    }
    Ok(())
}

fn cstr(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

fn parse_octal(field: &[u8]) -> usize {
    let s = cstr(field);
    usize::from_str_radix(s.trim(), 8).unwrap_or(0)
}

fn mkdirs<B: Backend + ?Sized>(backend: &mut B, path: &str) -> Result<()> {
    let mut cur = String::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if cur.is_empty() {
            cur.push_str(seg);
        } else {
            cur = format!("{cur}/{seg}");
        }
        if backend.entry(&cur)?.is_none() {
            backend.mkdir(&cur)?;
        }
    }
    Ok(())
}

/// Import entries into the backend (merge/overwrite; missing parents created).
pub fn import<B: Backend + ?Sized>(backend: &mut B, tar: &[u8]) -> Result<()> {
    let mut at = 0usize;
    while at + BLOCK <= tar.len() {
        let h = &tar[at..at + BLOCK];
        if h.iter().all(|&b| b == 0) {
            break;
        }
        let prefix = cstr(&h[345..500]);
        let name_field = cstr(&h[..100]);
        let name = if prefix.is_empty() {
            name_field
        } else {
            format!("{prefix}/{name_field}")
        };
        let size = parse_octal(&h[124..136]);
        let typeflag = h[156];
        at += BLOCK;
        let clean = name.trim_matches('/');
        if typeflag == b'5' {
            if !clean.is_empty() {
                mkdirs(backend, clean)?;
            }
        } else if typeflag == b'0' || typeflag == 0 {
            if !clean.is_empty() {
                let (parent, _) = split_parent(clean);
                mkdirs(backend, parent)?;
                let end = (at + size).min(tar.len());
                backend.write(clean, &tar[at.min(end)..end])?;
            }
            at += size.div_ceil(BLOCK) * BLOCK;
        } else {
            at += size.div_ceil(BLOCK) * BLOCK; // skip links/other types
        }
    }
    Ok(())
}
