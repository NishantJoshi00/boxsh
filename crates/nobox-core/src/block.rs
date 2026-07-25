//! Fixed-size block storage.

use crate::{Error, Result};

/// Size of each block in bytes.
pub const BLOCK_SIZE: usize = 4096;

/// A backend: an addressable array of 4 KiB blocks.
///
pub trait BlockStore {
    /// Read block `index` into `buf`.
    fn read_block(&mut self, index: u64, buf: &mut [u8; BLOCK_SIZE]) -> Result<()>;
    /// Write `buf` to block `index`.
    fn write_block(&mut self, index: u64, buf: &[u8; BLOCK_SIZE]) -> Result<()>;
    /// Number of addressable blocks.
    fn block_count(&self) -> u64;
    /// Make all prior writes durable.
    fn flush(&mut self) -> Result<()>;
}

/// An in-memory block store.
pub struct MemoryStore {
    blocks: Vec<Box<[u8; BLOCK_SIZE]>>,
}

impl MemoryStore {
    pub fn new(block_count: u64) -> Self {
        let blocks = (0..block_count)
            .map(|_| Box::new([0u8; BLOCK_SIZE]))
            .collect();
        Self { blocks }
    }

    fn get(&mut self, index: u64) -> Result<&mut [u8; BLOCK_SIZE]> {
        self.blocks
            .get_mut(usize::try_from(index).map_err(|_| Error::OutOfRange)?)
            .map(Box::as_mut)
            .ok_or(Error::OutOfRange)
    }
}

impl BlockStore for MemoryStore {
    fn read_block(&mut self, index: u64, buf: &mut [u8; BLOCK_SIZE]) -> Result<()> {
        buf.copy_from_slice(self.get(index)?);
        Ok(())
    }

    fn write_block(&mut self, index: u64, buf: &[u8; BLOCK_SIZE]) -> Result<()> {
        self.get(index)?.copy_from_slice(buf);
        Ok(())
    }

    fn block_count(&self) -> u64 {
        self.blocks.len() as u64
    }

    fn flush(&mut self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_block() {
        let mut store = MemoryStore::new(4);
        let mut block = [0u8; BLOCK_SIZE];
        block[0] = 0xAB;
        block[BLOCK_SIZE - 1] = 0xCD;
        store.write_block(2, &block).unwrap();

        let mut out = [0u8; BLOCK_SIZE];
        store.read_block(2, &mut out).unwrap();
        assert_eq!(block, out);
    }

    #[test]
    fn rejects_out_of_range() {
        let mut store = MemoryStore::new(2);
        let mut buf = [0u8; BLOCK_SIZE];
        assert_eq!(store.read_block(2, &mut buf), Err(Error::OutOfRange));
        assert_eq!(store.write_block(9, &buf), Err(Error::OutOfRange));
    }

    #[test]
    fn fresh_blocks_are_zeroed() {
        let mut store = MemoryStore::new(1);
        let mut buf = [0xFFu8; BLOCK_SIZE];
        store.read_block(0, &mut buf).unwrap();
        assert!(buf.iter().all(|&b| b == 0));
        assert_eq!(store.block_count(), 1);
        store.flush().unwrap();
    }
}
