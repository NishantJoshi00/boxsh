//! The boxsh virtual filesystem: path-level state with pluggable persistence.
//!
//! State is a map from backend-form paths to nodes. Backend form: `""` is the
//! root, segments are joined by `/`, no leading slash — see [`normalize`].
//!
//! [`MemoryBackend`] is the canonical implementation and the in-wasm working
//! state of every sandbox. Persistent backends come in two shapes:
//!
//! - **Native**: implement [`Backend`] directly (SQL stores, archive files).
//! - **Replicated**: the host mirrors the memory state through its dirty-path
//!   journal ([`MemoryBackend::take_dirty`]) into storage the sandbox cannot
//!   reach itself (IndexedDB, OPFS from a browser host).
//!
//! See DESIGN.md for the replication contract and the deliberate semantic
//! differences from the TypeScript memory backend this crate supersedes.

pub mod memory;
pub mod tar;

pub use memory::MemoryBackend;

use std::fmt;

/// What a path points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
}

/// Metadata for a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub kind: Kind,
    /// File length in bytes; 0 for directories.
    pub size: u64,
    /// Milliseconds since epoch.
    pub mtime: u64,
}

/// Errno-shaped filesystem errors. Hosts map these onto their native error
/// vocabulary (the TypeScript layer's `ErrnoCode`, POSIX errno over FFI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// ENOENT
    NotFound,
    /// EEXIST
    Exists,
    /// ENOTDIR
    NotDir,
    /// EISDIR
    IsDir,
    /// ENOTEMPTY
    NotEmpty,
    /// EINVAL
    Invalid,
    /// EIO — the persistence layer failed.
    Io(String),
    /// Stored data failed to parse.
    Corrupt(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound => f.write_str("no such file or directory"),
            Error::Exists => f.write_str("file exists"),
            Error::NotDir => f.write_str("not a directory"),
            Error::IsDir => f.write_str("is a directory"),
            Error::NotEmpty => f.write_str("directory not empty"),
            Error::Invalid => f.write_str("invalid argument"),
            Error::Io(m) => write!(f, "io error: {m}"),
            Error::Corrupt(m) => write!(f, "corrupt data: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = core::result::Result<T, Error>;

/// Storage operations behind a boxsh filesystem — the Rust twin of the
/// TypeScript `StorageBackend` contract. Paths are backend form; callers
/// normalize first.
pub trait Backend {
    fn kind_name(&self) -> &'static str;

    /// File contents. `NotFound` if missing, `IsDir` for a directory.
    fn read(&mut self, path: &str) -> Result<Vec<u8>>;
    /// Create or overwrite a file. The parent directory must exist.
    fn write(&mut self, path: &str, data: &[u8]) -> Result<()>;
    /// Metadata for a path, or `None` if it does not exist.
    fn entry(&mut self, path: &str) -> Result<Option<Entry>>;
    /// Child names of a directory, in sorted order.
    fn list(&mut self, path: &str) -> Result<Vec<String>>;
    /// Create one directory level. The parent must exist.
    fn mkdir(&mut self, path: &str) -> Result<()>;
    /// Remove a file or an empty directory. The root is not removable.
    fn remove(&mut self, path: &str) -> Result<()>;
    /// Rename a file or directory subtree. Replaces a file or empty
    /// directory at `to`; refuses a non-empty one and a `to` inside `from`.
    fn rename(&mut self, from: &str, to: &str) -> Result<()>;

    /// Make everything written so far durable.
    fn flush(&mut self) -> Result<()>;
}

/// Normalize any user path to backend form (`""` = root). Mirrors
/// `normalize` in the TypeScript layer.
pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// Split a backend-form path into (parent, base). The root splits to
/// `("", "")`; a top-level name splits to `("", name)`.
pub fn split_parent(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_the_ts_layer() {
        assert_eq!(normalize("/a/b/"), "a/b");
        assert_eq!(normalize("a//b/./c"), "a/b/c");
        assert_eq!(normalize("a/b/../c"), "a/c");
        assert_eq!(normalize("../.."), "");
        assert_eq!(normalize("/"), "");
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn splits_parents() {
        assert_eq!(split_parent(""), ("", ""));
        assert_eq!(split_parent("a"), ("", "a"));
        assert_eq!(split_parent("a/b/c"), ("a/b", "c"));
    }
}
