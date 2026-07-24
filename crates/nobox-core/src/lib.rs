//! nobox-core: the virtual filesystem.
//!
//! Everything in this crate is pure, synchronous, and deterministic
//! (invariant #1). No ambient I/O, clocks, randomness, or host calls;
//! the environment enters only through injected interfaces such as
//! [`BlockStore`]. Zero dependencies (D10).

pub mod block;

pub use block::{BLOCK_SIZE, BlockStore, MemoryStore};

/// Errors surfaced by the storage and (future) VFS layers.
///
/// Semantic at this layer; mapped to WASI errnos at the syscall shim and to
/// POSIX errno text at the command surface (D9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Block index outside the store's range.
    OutOfRange,
    /// The backend failed to read or write.
    Io,
}

pub type Result<T> = core::result::Result<T, Error>;
