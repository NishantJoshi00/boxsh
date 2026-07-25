//! Storage primitives for nobox.

pub mod block;

pub use block::{BLOCK_SIZE, BlockStore, MemoryStore};

/// Errors returned by storage operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Block index outside the store's range.
    OutOfRange,
    /// The backend failed to read or write.
    Io,
}

pub type Result<T> = core::result::Result<T, Error>;
