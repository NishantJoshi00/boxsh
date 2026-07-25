//! Functions used to load and exchange data with nobox modules.

/// Version of the exported functions.
pub const ABI_VERSION: u32 = 1;

/// Return the version of the exported functions.
#[unsafe(no_mangle)]
pub extern "C" fn nobox_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes and return a pointer to them.
#[unsafe(no_mangle)]
pub extern "C" fn nobox_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by [`nobox_alloc`].
///
/// # Safety
/// `ptr` must come from `nobox_alloc(len)` with this exact `len`, and must
/// not have been freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nobox_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_version_is_current() {
        assert_eq!(nobox_abi_version(), 1);
    }

    #[test]
    fn alloc_free_round_trip() {
        let ptr = nobox_alloc(4096);
        assert!(!ptr.is_null());
        unsafe {
            ptr.write_bytes(0x5A, 4096);
            nobox_free(ptr, 4096);
        }
    }
}
