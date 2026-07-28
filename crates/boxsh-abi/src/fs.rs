//! Filesystem exports: `boxsh-fs` behind the ABI.
//!
//! The filesystem state lives entirely on this side of the boundary; hosts
//! hold an opaque handle and speak the `StorageBackend` contract through
//! these exports. Persistence hosts additionally drain the replication
//! journal (`boxsh_fs_take_dirty`) and hydrate with `boxsh_fs_restore` —
//! see boxsh-fs/DESIGN.md for that contract.
//!
//! Conventions (shared with the rest of the ABI):
//! - Strings and bytes cross as `(ptr, len)` pairs in linear memory; the
//!   host stages inputs with `boxsh_alloc`.
//! - Variable-size results are callee-allocated exact-capacity buffers;
//!   their `(ptr, len)` is written into the host's `out` cell as two
//!   pointer-width little-endian words (`u32` pairs on wasm32 — the layout
//!   hosts see; native test builds use the native word size), and the host
//!   frees them with `boxsh_free`. A zero `len` means an empty result and
//!   nothing to free.
//! - Path lists (`list`, `take_dirty`) are encoded as repeated
//!   `u32 little-endian length + UTF-8 bytes`.
//! - Entry results are a 24-byte cell: `u64 kind` (0 = missing, 1 = file,
//!   2 = dir), `u64 size`, `u64 mtime`, all little-endian.
//! - Every call returns `0` for success or a negative status. Out cells
//!   are written only on success.

use std::cell::RefCell;

use boxsh_fs::{Backend, Error, Kind, MemoryBackend};

pub const OK: i32 = 0;
pub const ERR_NOT_FOUND: i32 = -1;
pub const ERR_EXISTS: i32 = -2;
pub const ERR_NOT_DIR: i32 = -3;
pub const ERR_IS_DIR: i32 = -4;
pub const ERR_NOT_EMPTY: i32 = -5;
pub const ERR_INVALID: i32 = -6;
pub const ERR_IO: i32 = -7;
pub const ERR_CORRUPT: i32 = -8;
pub const ERR_BAD_HANDLE: i32 = -9;
pub const ERR_UTF8: i32 = -10;

pub(crate) fn status_code(e: &Error) -> i32 {
    match e {
        Error::NotFound => ERR_NOT_FOUND,
        Error::Exists => ERR_EXISTS,
        Error::NotDir => ERR_NOT_DIR,
        Error::IsDir => ERR_IS_DIR,
        Error::NotEmpty => ERR_NOT_EMPTY,
        Error::Invalid => ERR_INVALID,
        Error::Io(_) => ERR_IO,
        Error::Corrupt(_) => ERR_CORRUPT,
    }
}

thread_local! {
    static FILESYSTEMS: RefCell<Vec<Option<MemoryBackend>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn with_fs<T>(
    handle: i32,
    f: impl FnOnce(&mut MemoryBackend) -> Result<T, i32>,
) -> Result<T, i32> {
    FILESYSTEMS.with(|cell| {
        let mut registry = cell.borrow_mut();
        let fs = usize::try_from(handle)
            .ok()
            .and_then(|i| registry.get_mut(i))
            .and_then(Option::as_mut)
            .ok_or(ERR_BAD_HANDLE)?;
        f(fs)
    })
}

fn to_status(r: Result<(), i32>) -> i32 {
    match r {
        Ok(()) => OK,
        Err(code) => code,
    }
}

/// # Safety
/// `ptr` must be valid for `len` bytes (or `len` must be 0).
pub(crate) unsafe fn bytes_arg<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(ptr, len) }
    }
}

/// # Safety
/// `ptr` must be valid for `len` bytes (or `len` must be 0).
pub(crate) unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str, i32> {
    core::str::from_utf8(unsafe { bytes_arg(ptr, len) }).map_err(|_| ERR_UTF8)
}

/// Hand a buffer to the host: exact-capacity allocation whose `(ptr, len)`
/// is written into the out cell as two pointer-width little-endian words —
/// `u32` pairs on wasm32, which is the layout hosts see. The host frees the
/// buffer with `boxsh_free`.
///
/// # Safety
/// `out` must be valid for two pointer-width writable words. No alignment
/// is required.
pub(crate) unsafe fn emit(out: *mut u8, bytes: Vec<u8>) {
    let len = bytes.len();
    let ptr = if bytes.is_empty() {
        0usize
    } else {
        // `into_boxed_slice` guarantees capacity == len, matching the
        // `Vec::from_raw_parts(ptr, 0, len)` reconstruction in `boxsh_free`.
        Box::into_raw(bytes.into_boxed_slice()) as *mut u8 as usize
    };
    unsafe {
        write_word(out, ptr);
        write_word(out.add(size_of::<usize>()), len);
    }
}

/// # Safety
/// `at` must be valid for `size_of::<usize>()` writable bytes. No alignment
/// is required.
unsafe fn write_word(at: *mut u8, v: usize) {
    unsafe {
        at.cast::<[u8; size_of::<usize>()]>()
            .write_unaligned(v.to_le_bytes())
    }
}

/// # Safety
/// `at` must be valid for 8 writable bytes. No alignment is required.
unsafe fn write_u64(at: *mut u8, v: u64) {
    unsafe { at.cast::<[u8; 8]>().write_unaligned(v.to_le_bytes()) }
}

pub(crate) fn encode_path_list(paths: &[String]) -> Vec<u8> {
    let total = paths.iter().map(|p| 4 + p.len()).sum();
    let mut out = Vec::with_capacity(total);
    for p in paths {
        let len = u32::try_from(p.len()).expect("path length fits in u32");
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(p.as_bytes());
    }
    out
}

/// Create a filesystem and return its handle.
#[unsafe(no_mangle)]
pub extern "C" fn boxsh_fs_new() -> i32 {
    FILESYSTEMS.with(|cell| {
        let mut registry = cell.borrow_mut();
        let fs = Some(MemoryBackend::new());
        match registry.iter().position(Option::is_none) {
            Some(i) => {
                registry[i] = fs;
                i32::try_from(i).expect("handle fits in i32")
            }
            None => {
                registry.push(fs);
                i32::try_from(registry.len() - 1).expect("handle fits in i32")
            }
        }
    })
}

/// Release a filesystem. The handle may be reused by a later `boxsh_fs_new`.
#[unsafe(no_mangle)]
pub extern "C" fn boxsh_fs_drop(handle: i32) -> i32 {
    FILESYSTEMS.with(|cell| {
        let mut registry = cell.borrow_mut();
        match usize::try_from(handle)
            .ok()
            .and_then(|i| registry.get_mut(i))
        {
            Some(slot) if slot.is_some() => {
                *slot = None;
                OK
            }
            _ => ERR_BAD_HANDLE,
        }
    })
}

/// Set the clock used to stamp mtimes, in milliseconds since epoch.
#[unsafe(no_mangle)]
pub extern "C" fn boxsh_fs_set_time(handle: i32, now_ms: u64) -> i32 {
    to_status(with_fs(handle, |fs| {
        fs.set_time(now_ms);
        Ok(())
    }))
}

/// # Safety
/// `path` must be valid for `path_len` bytes; `out` for 8 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_read(
    handle: i32,
    path: *const u8,
    path_len: usize,
    out: *mut u8,
) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        let data = with_fs(handle, |fs| fs.read(p).map_err(|e| status_code(&e)))?;
        unsafe { emit(out, data) };
        Ok(())
    })())
}

/// # Safety
/// `path` must be valid for `path_len` bytes; `data` for `data_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_write(
    handle: i32,
    path: *const u8,
    path_len: usize,
    data: *const u8,
    data_len: usize,
) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        let bytes = unsafe { bytes_arg(data, data_len) };
        with_fs(handle, |fs| fs.write(p, bytes).map_err(|e| status_code(&e)))
    })())
}

/// # Safety
/// `path` must be valid for `path_len` bytes; `out` for 24 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_entry(
    handle: i32,
    path: *const u8,
    path_len: usize,
    out: *mut u8,
) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        let entry = with_fs(handle, |fs| fs.entry(p).map_err(|e| status_code(&e)))?;
        let (kind, size, mtime) = match entry {
            None => (0, 0, 0),
            Some(e) => {
                let kind = match e.kind {
                    Kind::File => 1,
                    Kind::Dir => 2,
                };
                (kind, e.size, e.mtime)
            }
        };
        unsafe {
            write_u64(out, kind);
            write_u64(out.add(8), size);
            write_u64(out.add(16), mtime);
        }
        Ok(())
    })())
}

/// # Safety
/// `path` must be valid for `path_len` bytes; `out` for 8 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_list(
    handle: i32,
    path: *const u8,
    path_len: usize,
    out: *mut u8,
) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        let names = with_fs(handle, |fs| fs.list(p).map_err(|e| status_code(&e)))?;
        unsafe { emit(out, encode_path_list(&names)) };
        Ok(())
    })())
}

/// # Safety
/// `path` must be valid for `path_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_mkdir(handle: i32, path: *const u8, path_len: usize) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        with_fs(handle, |fs| fs.mkdir(p).map_err(|e| status_code(&e)))
    })())
}

/// # Safety
/// `path` must be valid for `path_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_remove(handle: i32, path: *const u8, path_len: usize) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        with_fs(handle, |fs| fs.remove(p).map_err(|e| status_code(&e)))
    })())
}

/// # Safety
/// `from` must be valid for `from_len` bytes; `to` for `to_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_rename(
    handle: i32,
    from: *const u8,
    from_len: usize,
    to: *const u8,
    to_len: usize,
) -> i32 {
    to_status((|| {
        let f = unsafe { str_arg(from, from_len) }?;
        let t = unsafe { str_arg(to, to_len) }?;
        with_fs(handle, |fs| fs.rename(f, t).map_err(|e| status_code(&e)))
    })())
}

/// Drain the replication journal: paths touched since the last drain, in
/// sorted order, path-list encoded.
///
/// # Safety
/// `out` must be valid for 8 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_take_dirty(handle: i32, out: *mut u8) -> i32 {
    to_status((|| {
        let dirty = with_fs(handle, |fs| Ok(fs.take_dirty()))?;
        unsafe { emit(out, encode_path_list(&dirty)) };
        Ok(())
    })())
}

/// Recreate a node during hydration; see `MemoryBackend::restore`. A nonzero
/// `is_dir` restores a directory and ignores `data`.
///
/// # Safety
/// `path` must be valid for `path_len` bytes; `data` for `data_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_restore(
    handle: i32,
    path: *const u8,
    path_len: usize,
    mtime: u64,
    is_dir: i32,
    data: *const u8,
    data_len: usize,
) -> i32 {
    to_status((|| {
        let p = unsafe { str_arg(path, path_len) }?;
        let bytes = if is_dir != 0 {
            None
        } else {
            Some(unsafe { bytes_arg(data, data_len) })
        };
        with_fs(handle, |fs| {
            fs.restore(p, mtime, bytes).map_err(|e| status_code(&e))
        })
    })())
}

/// The whole tree as a tar archive (boxsh-fs's ustar codec).
///
/// # Safety
/// `out` must be valid for two pointer-width writable words.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_export_tar(handle: i32, out: *mut u8) -> i32 {
    to_status((|| {
        let archive = with_fs(handle, |fs| {
            boxsh_fs::tar::export(fs).map_err(|e| status_code(&e))
        })?;
        unsafe { emit(out, archive) };
        Ok(())
    })())
}

/// Merge a tar archive into the tree (overwrite; missing parents created).
///
/// # Safety
/// `tar` must be valid for `tar_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_fs_import_tar(handle: i32, tar: *const u8, tar_len: usize) -> i32 {
    let archive = unsafe { bytes_arg(tar, tar_len) };
    to_status(with_fs(handle, |fs| {
        boxsh_fs::tar::import(fs, archive).map_err(|e| status_code(&e))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Out cells hold two pointer-width words; 16 bytes covers every target.
    type OutCell = [u8; 16];
    const WORD: usize = size_of::<usize>();

    /// Call an export the way a host does: stage inputs, decode outputs.
    fn call_read(h: i32, path: &str) -> Result<Vec<u8>, i32> {
        let mut out: OutCell = [0; 16];
        let s = unsafe { boxsh_fs_read(h, path.as_ptr(), path.len(), out.as_mut_ptr()) };
        if s != OK {
            return Err(s);
        }
        Ok(take_buffer(&out))
    }

    fn take_buffer(out: &OutCell) -> Vec<u8> {
        let ptr = usize::from_le_bytes(out[..WORD].try_into().unwrap());
        let len = usize::from_le_bytes(out[WORD..2 * WORD].try_into().unwrap());
        if len == 0 {
            return Vec::new();
        }
        let data = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) }.to_vec();
        unsafe { crate::boxsh_free(ptr as *mut u8, len) };
        data
    }

    fn decode_path_list(bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            at += 4;
            out.push(String::from_utf8(bytes[at..at + len].to_vec()).unwrap());
            at += len;
        }
        out
    }

    fn call_write(h: i32, path: &str, data: &[u8]) -> i32 {
        unsafe { boxsh_fs_write(h, path.as_ptr(), path.len(), data.as_ptr(), data.len()) }
    }

    fn call_entry(h: i32, path: &str) -> (u64, u64, u64) {
        let mut out = [0u8; 24];
        let s = unsafe { boxsh_fs_entry(h, path.as_ptr(), path.len(), out.as_mut_ptr()) };
        assert_eq!(s, OK);
        (
            u64::from_le_bytes(out[..8].try_into().unwrap()),
            u64::from_le_bytes(out[8..16].try_into().unwrap()),
            u64::from_le_bytes(out[16..].try_into().unwrap()),
        )
    }

    #[test]
    fn full_roundtrip_through_the_abi() {
        let h = boxsh_fs_new();
        assert_eq!(boxsh_fs_set_time(h, 5000), OK);
        assert_eq!(unsafe { boxsh_fs_mkdir(h, "dir".as_ptr(), 3) }, OK);
        assert_eq!(call_write(h, "dir/f.txt", b"hello"), OK);
        assert_eq!(call_read(h, "dir/f.txt").unwrap(), b"hello");
        assert_eq!(call_entry(h, "dir/f.txt"), (1, 5, 5000));
        assert_eq!(call_entry(h, "dir"), (2, 0, 5000));
        assert_eq!(call_entry(h, "missing"), (0, 0, 0));

        let mut out: OutCell = [0; 16];
        let s = unsafe { boxsh_fs_list(h, "dir".as_ptr(), 3, out.as_mut_ptr()) };
        assert_eq!(s, OK);
        assert_eq!(decode_path_list(&take_buffer(&out)), vec!["f.txt"]);

        assert_eq!(boxsh_fs_drop(h), OK);
    }

    #[test]
    fn statuses_are_errno_shaped() {
        let h = boxsh_fs_new();
        assert_eq!(call_read(h, "missing"), Err(ERR_NOT_FOUND));
        assert_eq!(call_write(h, "missing/f", b"x"), ERR_NOT_FOUND);
        assert_eq!(unsafe { boxsh_fs_mkdir(h, "d".as_ptr(), 1) }, OK);
        assert_eq!(unsafe { boxsh_fs_mkdir(h, "d".as_ptr(), 1) }, ERR_EXISTS);
        assert_eq!(call_read(h, "d"), Err(ERR_IS_DIR));
        assert_eq!(call_write(h, "f", b"x"), OK);
        assert_eq!(unsafe { boxsh_fs_remove(h, "d".as_ptr(), 1) }, OK,);
        let bad = [0xffu8, 0xfe];
        let mut out: OutCell = [0; 16];
        assert_eq!(
            unsafe { boxsh_fs_read(h, bad.as_ptr(), 2, out.as_mut_ptr()) },
            ERR_UTF8,
        );
        assert_eq!(boxsh_fs_drop(h), OK);
    }

    #[test]
    fn handles_are_isolated_and_reusable() {
        let a = boxsh_fs_new();
        let b = boxsh_fs_new();
        assert_ne!(a, b);
        assert_eq!(call_write(a, "only-a", b"1"), OK);
        assert_eq!(call_read(b, "only-a"), Err(ERR_NOT_FOUND));

        assert_eq!(boxsh_fs_drop(a), OK);
        assert_eq!(boxsh_fs_drop(a), ERR_BAD_HANDLE);
        assert_eq!(call_write(a, "x", b"1"), ERR_BAD_HANDLE);

        let c = boxsh_fs_new();
        assert_eq!(a, c, "dropped handle slots are reused");
        assert_eq!(
            call_read(c, "only-a"),
            Err(ERR_NOT_FOUND),
            "reused slot is fresh"
        );
        assert_eq!(boxsh_fs_drop(b), OK);
        assert_eq!(boxsh_fs_drop(c), OK);
    }

    #[test]
    fn tar_round_trips_through_the_abi() {
        let h = boxsh_fs_new();
        assert_eq!(boxsh_fs_set_time(h, 1000), OK);
        assert_eq!(unsafe { boxsh_fs_mkdir(h, "d".as_ptr(), 1) }, OK);
        assert_eq!(call_write(h, "d/f.txt", b"tarred"), OK);

        let mut out: OutCell = [0; 16];
        assert_eq!(unsafe { boxsh_fs_export_tar(h, out.as_mut_ptr()) }, OK);
        let archive = take_buffer(&out);
        assert_eq!(archive.len() % 512, 0);

        let r = boxsh_fs_new();
        assert_eq!(
            unsafe { boxsh_fs_import_tar(r, archive.as_ptr(), archive.len()) },
            OK
        );
        assert_eq!(call_read(r, "d/f.txt").unwrap(), b"tarred");
        assert_eq!(boxsh_fs_drop(h), OK);
        assert_eq!(boxsh_fs_drop(r), OK);
    }

    #[test]
    fn journal_and_restore_cross_the_abi() {
        let h = boxsh_fs_new();
        assert_eq!(boxsh_fs_set_time(h, 7000), OK);
        assert_eq!(unsafe { boxsh_fs_mkdir(h, "d".as_ptr(), 1) }, OK);
        assert_eq!(call_write(h, "d/f", b"x"), OK);

        let mut out: OutCell = [0; 16];
        assert_eq!(unsafe { boxsh_fs_take_dirty(h, out.as_mut_ptr()) }, OK);
        assert_eq!(decode_path_list(&take_buffer(&out)), vec!["d", "d/f"]);
        // Drained: the journal is empty until the next mutation.
        assert_eq!(unsafe { boxsh_fs_take_dirty(h, out.as_mut_ptr()) }, OK);
        assert_eq!(decode_path_list(&take_buffer(&out)), Vec::<String>::new());

        // Hydrate a second filesystem the way a persistence host would.
        let r = boxsh_fs_new();
        let path = "d";
        assert_eq!(
            unsafe { boxsh_fs_restore(r, path.as_ptr(), path.len(), 111, 1, core::ptr::null(), 0) },
            OK
        );
        let path = "d/f";
        let data = b"x";
        assert_eq!(
            unsafe { boxsh_fs_restore(r, path.as_ptr(), path.len(), 222, 0, data.as_ptr(), 1) },
            OK
        );
        assert_eq!(call_read(r, "d/f").unwrap(), b"x");
        assert_eq!(call_entry(r, "d/f"), (1, 1, 222));
        assert_eq!(call_entry(r, "d"), (2, 0, 111));
        // Restore journals nothing.
        assert_eq!(unsafe { boxsh_fs_take_dirty(r, out.as_mut_ptr()) }, OK);
        assert_eq!(decode_path_list(&take_buffer(&out)), Vec::<String>::new());

        assert_eq!(boxsh_fs_drop(h), OK);
        assert_eq!(boxsh_fs_drop(r), OK);
    }
}
