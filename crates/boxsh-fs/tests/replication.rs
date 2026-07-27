//! The dirty-path journal and its replication contract: a host that applies
//! every drained batch to a store, then hydrates a fresh backend from that
//! store, must end up with an identical tree. Exercised here with a second
//! MemoryBackend standing in for the store, plus tar round-trips.

use boxsh_fs::{Backend, Error, Kind, MemoryBackend, tar};

/// Apply one drained batch the way a host adapter would: resolve each dirty
/// path against the source's current state; upserts in order (parents first),
/// deletes in reverse (children first).
fn drain_into(src: &mut MemoryBackend, dst: &mut MemoryBackend) {
    let paths = src.take_dirty();
    for p in &paths {
        if let Some(e) = src.entry(p).unwrap() {
            let data = (e.kind == Kind::File).then(|| src.read(p).unwrap());
            dst.restore(p, e.mtime, data.as_deref()).unwrap();
        }
    }
    for p in paths.iter().rev() {
        if src.entry(p).unwrap().is_none() {
            match dst.remove(p) {
                Ok(()) | Err(Error::NotFound) => {}
                Err(e) => panic!("replica delete {p}: {e}"),
            }
        }
    }
}

type Snap = Vec<(String, Kind, u64, u64, Option<Vec<u8>>)>;

fn snapshot(m: &MemoryBackend) -> Snap {
    m.entries()
        .map(|(p, e, d)| {
            (
                p.to_string(),
                e.kind,
                e.size,
                e.mtime,
                d.map(<[u8]>::to_vec),
            )
        })
        .collect()
}

#[test]
fn journal_records_touched_paths() {
    let mut m = MemoryBackend::new();
    assert_eq!(m.dirty_len(), 0);
    m.mkdir("d").unwrap();
    m.write("d/f", b"x").unwrap();
    m.write("d/f", b"y").unwrap(); // coalesces
    assert_eq!(m.take_dirty(), vec!["d".to_string(), "d/f".to_string()]);
    assert_eq!(m.dirty_len(), 0);

    // Failed operations mark nothing.
    assert_eq!(m.write("missing/f", b"x"), Err(Error::NotFound));
    assert_eq!(m.take_dirty(), Vec::<String>::new());

    // Reads mark nothing.
    m.read("d/f").unwrap();
    m.list("d").unwrap();
    assert_eq!(m.take_dirty(), Vec::<String>::new());
}

#[test]
fn rename_journals_old_and_new_subtree_paths() {
    let mut m = MemoryBackend::new();
    m.mkdir("a").unwrap();
    m.write("a/f", b"x").unwrap();
    m.take_dirty();
    m.rename("a", "b").unwrap();
    assert_eq!(
        m.take_dirty(),
        vec![
            "a".to_string(),
            "a/f".to_string(),
            "b".to_string(),
            "b/f".to_string()
        ]
    );
}

#[test]
fn restore_does_not_journal_and_preserves_mtime() {
    let mut m = MemoryBackend::new();
    m.restore("", 42, None).unwrap();
    m.restore("d", 100, None).unwrap();
    m.restore("d/f", 200, Some(b"data")).unwrap();
    assert_eq!(m.dirty_len(), 0);
    assert_eq!(m.entry("").unwrap().unwrap().mtime, 42);
    assert_eq!(m.entry("d/f").unwrap().unwrap().mtime, 200);
    assert_eq!(m.read("d/f").unwrap(), b"data");
    // Parents must exist: hydration happens in sorted order.
    assert_eq!(m.restore("x/y", 0, None), Err(Error::NotFound));
}

#[test]
fn replica_converges_through_drains() {
    let mut src = MemoryBackend::new();
    let mut replica = MemoryBackend::new();

    src.set_time(1000);
    src.mkdir("src").unwrap();
    src.mkdir("src/deep").unwrap();
    src.write("src/a.txt", b"alpha").unwrap();
    src.write("src/deep/b.bin", &[0u8, 1, 255, 7]).unwrap();
    drain_into(&mut src, &mut replica);
    assert_eq!(snapshot(&src), snapshot(&replica));

    // Mutate: overwrite, rename a subtree, delete, replace a dir with a file.
    src.set_time(2000);
    src.write("src/a.txt", b"ALPHA2").unwrap();
    src.rename("src/deep", "src/moved").unwrap();
    src.remove("src/moved/b.bin").unwrap();
    src.remove("src/moved").unwrap();
    src.write("src/moved", b"now a file").unwrap();
    drain_into(&mut src, &mut replica);
    assert_eq!(snapshot(&src), snapshot(&replica));

    // Empty drain is a no-op.
    drain_into(&mut src, &mut replica);
    assert_eq!(snapshot(&src), snapshot(&replica));
}

#[test]
fn tar_roundtrip_preserves_structure_and_content() {
    let mut src = MemoryBackend::new();
    src.set_time(1_700_000_000_000);
    src.mkdir("dir").unwrap();
    src.mkdir("dir/nested").unwrap();
    src.write("dir/hello.txt", b"hello\n").unwrap();
    src.write("dir/nested/blob.bin", &vec![0xabu8; 8_700])
        .unwrap(); // spans blocks
    src.write("empty", b"").unwrap();

    let archive = tar::export(&mut src).unwrap();
    assert_eq!(archive.len() % 512, 0);

    let mut dst = MemoryBackend::new();
    tar::import(&mut dst, &archive).unwrap();
    let strip = |m: &MemoryBackend| {
        m.entries()
            .map(|(p, e, d)| (p.to_string(), e.kind, e.size, d.map(<[u8]>::to_vec)))
            .collect::<Vec<_>>()
    };
    // mtimes are stamped at import time (matches tar.ts), so compare all else.
    assert_eq!(strip(&src), strip(&dst));
}

#[test]
fn tar_splits_long_names_into_prefix() {
    let mut src = MemoryBackend::new();
    let mut path = String::new();
    for seg in [
        "component-one",
        "component-two",
        "component-three",
        "component-four",
        "component-five",
        "component-six",
        "component-seven",
        "component-eight",
    ] {
        let next = if path.is_empty() {
            seg.to_string()
        } else {
            format!("{path}/{seg}")
        };
        src.mkdir(&next).unwrap();
        path = next;
        if path.len() > 88 {
            break;
        }
    }
    let file = format!("{path}/file-with-a-reasonably-long-name.txt");
    src.write(&file, b"deep").unwrap();
    assert!(
        file.len() > 100,
        "test path must exceed the ustar name field"
    );

    let archive = tar::export(&mut src).unwrap();
    let mut dst = MemoryBackend::new();
    tar::import(&mut dst, &archive).unwrap();
    assert_eq!(dst.read(&file).unwrap(), b"deep");
}

#[test]
fn tar_headers_have_valid_checksums() {
    let mut src = MemoryBackend::new();
    src.write("f.txt", b"data").unwrap();
    let archive = tar::export(&mut src).unwrap();
    let h = &archive[..512];
    let stored = u32::from_str_radix(
        std::str::from_utf8(&h[148..154])
            .unwrap()
            .trim_matches(['\0', ' ']),
        8,
    )
    .unwrap();
    let computed: u32 = h
        .iter()
        .enumerate()
        .map(|(i, &b)| {
            if (148..156).contains(&i) {
                32
            } else {
                u32::from(b)
            }
        })
        .sum();
    assert_eq!(stored, computed);
    assert_eq!(&h[257..262], b"ustar");
}

#[test]
fn tar_import_merges_and_overwrites() {
    let mut a = MemoryBackend::new();
    a.mkdir("shared").unwrap();
    a.write("shared/from-a.txt", b"a").unwrap();
    a.write("both.txt", b"old").unwrap();

    let mut b = MemoryBackend::new();
    b.write("both.txt", b"new").unwrap();
    b.mkdir("only-b").unwrap();
    let archive = tar::export(&mut b).unwrap();

    tar::import(&mut a, &archive).unwrap();
    assert_eq!(a.read("shared/from-a.txt").unwrap(), b"a"); // untouched
    assert_eq!(a.read("both.txt").unwrap(), b"new"); // overwritten
    assert_eq!(a.entry("only-b").unwrap().unwrap().kind, Kind::Dir);
}
