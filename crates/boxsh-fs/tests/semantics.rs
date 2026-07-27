//! The backend contract, ported from the TypeScript memory backend and its
//! public-API tests. Where behavior is deliberately hardened relative to
//! memory.ts (rename edge cases, root removal), the tests pin the hardened
//! behavior — see DESIGN.md.

use boxsh_fs::{Backend, Error, Kind, MemoryBackend};

fn b() -> MemoryBackend {
    MemoryBackend::new()
}

#[test]
fn root_exists_and_starts_empty() {
    let mut m = b();
    let root = m.entry("").unwrap().unwrap();
    assert_eq!(root.kind, Kind::Dir);
    assert_eq!(m.list("").unwrap(), Vec::<String>::new());
}

#[test]
fn write_read_roundtrip_including_binary() {
    let mut m = b();
    m.write("hello.txt", b"hello boxsh\n").unwrap();
    assert_eq!(m.read("hello.txt").unwrap(), b"hello boxsh\n");

    let bin: Vec<u8> = (0..4096u32).map(|i| (i & 0xff) as u8).collect();
    m.write("blob.bin", &bin).unwrap();
    assert_eq!(m.read("blob.bin").unwrap(), bin);

    m.write("hello.txt", b"shorter").unwrap();
    assert_eq!(m.read("hello.txt").unwrap(), b"shorter");
    assert_eq!(m.entry("hello.txt").unwrap().unwrap().size, 7);
}

#[test]
fn write_requires_parent_directory() {
    let mut m = b();
    assert_eq!(m.write("missing/f", b"x"), Err(Error::NotFound));
    m.write("file", b"x").unwrap();
    assert_eq!(m.write("file/f", b"x"), Err(Error::NotDir));
    m.mkdir("d").unwrap();
    m.write("d/f", b"x").unwrap();
    assert_eq!(m.read("d/f").unwrap(), b"x");
}

#[test]
fn write_over_directory_is_isdir() {
    let mut m = b();
    m.mkdir("d").unwrap();
    assert_eq!(m.write("d", b"x"), Err(Error::IsDir));
    assert_eq!(m.write("", b"x"), Err(Error::IsDir));
}

#[test]
fn read_errors() {
    let mut m = b();
    assert_eq!(m.read("missing"), Err(Error::NotFound));
    m.mkdir("d").unwrap();
    assert_eq!(m.read("d"), Err(Error::IsDir));
}

#[test]
fn entry_reports_size_mtime_and_kind() {
    let mut m = b();
    m.set_time(5000);
    m.write("f", b"12345").unwrap();
    m.mkdir("d").unwrap();
    let f = m.entry("f").unwrap().unwrap();
    assert_eq!((f.kind, f.size, f.mtime), (Kind::File, 5, 5000));
    let d = m.entry("d").unwrap().unwrap();
    assert_eq!((d.kind, d.size, d.mtime), (Kind::Dir, 0, 5000));
    assert_eq!(m.entry("missing").unwrap(), None);
    // Overwrite restamps the mtime.
    m.set_time(9000);
    m.write("f", b"x").unwrap();
    assert_eq!(m.entry("f").unwrap().unwrap().mtime, 9000);
}

#[test]
fn list_returns_sorted_immediate_children() {
    let mut m = b();
    m.mkdir("d").unwrap();
    m.mkdir("d/sub").unwrap();
    m.write("d/b.txt", b"1").unwrap();
    m.write("d/a.txt", b"2").unwrap();
    m.write("d/sub/deep.txt", b"3").unwrap();
    assert_eq!(m.list("d").unwrap(), vec!["a.txt", "b.txt", "sub"]);
    assert_eq!(m.list("").unwrap(), vec!["d"]);
    assert_eq!(m.list("d/a.txt"), Err(Error::NotDir));
    assert_eq!(m.list("missing"), Err(Error::NotFound));
}

#[test]
fn mkdir_semantics() {
    let mut m = b();
    m.mkdir("a").unwrap();
    m.mkdir("a/b").unwrap();
    assert_eq!(m.mkdir("a"), Err(Error::Exists));
    assert_eq!(m.mkdir(""), Err(Error::Exists));
    m.write("f", b"x").unwrap();
    assert_eq!(m.mkdir("f"), Err(Error::Exists));
    assert_eq!(m.mkdir("missing/d"), Err(Error::NotFound));
    assert_eq!(m.mkdir("f/d"), Err(Error::NotDir));
}

#[test]
fn remove_semantics() {
    let mut m = b();
    m.mkdir("d").unwrap();
    m.write("d/f", b"x").unwrap();
    assert_eq!(m.remove("d"), Err(Error::NotEmpty));
    m.remove("d/f").unwrap();
    m.remove("d").unwrap();
    assert_eq!(m.entry("d").unwrap(), None);
    assert_eq!(m.remove("missing"), Err(Error::NotFound));
    assert_eq!(m.remove(""), Err(Error::Invalid));
}

#[test]
fn rename_file() {
    let mut m = b();
    m.set_time(1000);
    m.write("old.txt", b"data").unwrap();
    m.set_time(2000);
    m.rename("old.txt", "new.txt").unwrap();
    assert_eq!(m.entry("old.txt").unwrap(), None);
    assert_eq!(m.read("new.txt").unwrap(), b"data");
    // Rename preserves the node's mtime.
    assert_eq!(m.entry("new.txt").unwrap().unwrap().mtime, 1000);
}

#[test]
fn rename_moves_whole_subtree() {
    let mut m = b();
    m.mkdir("src").unwrap();
    m.mkdir("src/deep").unwrap();
    m.write("src/a.txt", b"a").unwrap();
    m.write("src/deep/b.txt", b"b").unwrap();
    m.mkdir("dst").unwrap();
    m.rename("src", "dst/src").unwrap();
    assert_eq!(m.entry("src").unwrap(), None);
    assert_eq!(m.read("dst/src/a.txt").unwrap(), b"a");
    assert_eq!(m.read("dst/src/deep/b.txt").unwrap(), b"b");
    assert_eq!(m.list("dst/src").unwrap(), vec!["a.txt", "deep"]);
}

#[test]
fn rename_edge_cases() {
    let mut m = b();
    m.mkdir("a").unwrap();
    m.write("a/f", b"x").unwrap();
    // Into own subtree.
    assert_eq!(m.rename("a", "a/b"), Err(Error::Invalid));
    // Prefix but not subtree is fine.
    m.mkdir("ab").unwrap();
    m.rename("ab", "ac").unwrap();
    // Missing source.
    assert_eq!(m.rename("missing", "x"), Err(Error::NotFound));
    // Destination parent missing / not a directory.
    assert_eq!(m.rename("a/f", "missing/f"), Err(Error::NotFound));
    m.write("file", b"x").unwrap();
    assert_eq!(m.rename("a/f", "file/f"), Err(Error::NotDir));
    // No-op.
    m.rename("a", "a").unwrap();
    assert_eq!(m.read("a/f").unwrap(), b"x");
    // Root is not renameable.
    assert_eq!(m.rename("", "x"), Err(Error::Invalid));
    assert_eq!(m.rename("a", ""), Err(Error::Invalid));
}

#[test]
fn rename_replaces_file_and_empty_dir_targets() {
    let mut m = b();
    m.write("src", b"new").unwrap();
    m.write("target", b"old").unwrap();
    m.rename("src", "target").unwrap();
    assert_eq!(m.read("target").unwrap(), b"new");

    m.mkdir("empty").unwrap();
    m.write("src2", b"file").unwrap();
    m.rename("src2", "empty").unwrap();
    assert_eq!(m.read("empty").unwrap(), b"file");

    m.mkdir("full").unwrap();
    m.write("full/child", b"x").unwrap();
    m.write("src3", b"y").unwrap();
    assert_eq!(m.rename("src3", "full"), Err(Error::NotEmpty));
}

#[test]
fn flush_is_a_noop_for_memory() {
    let mut m = b();
    m.write("f", b"x").unwrap();
    m.flush().unwrap();
    assert_eq!(m.read("f").unwrap(), b"x");
}
