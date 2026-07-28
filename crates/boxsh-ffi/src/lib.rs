//! C ABI for embedding the boxsh sandbox natively.
//!
//! A sandbox handle owns a filesystem, a shell session, and the in-module
//! command tier — the same Rust machinery the wasm build ships, minus the
//! wasm. Buffers returned through [`BoxshBuf`] are freed with
//! [`boxsh_buf_free`]. All calls return `0`/an exit code on success or a
//! negative status (the boxsh-abi errno codes). Handles are process-global
//! and thread-safe behind a mutex; calls are serialized per process.
//!
//! The uutils cold tier is a wasm-host concern and is not present here:
//! unknown commands exit 127. `include/boxsh.h` declares this surface for
//! C, Python (ctypes/cffi), Go (cgo), and friends.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use boxsh_fs::{Backend, Entry, MemoryBackend};
use boxsh_shell::{CommandOutput, CommandRunner, Env, Session, exec_script};

pub const OK: i32 = 0;
pub const ERR_NOT_FOUND: i32 = -1;
pub const ERR_IS_DIR: i32 = -4;
pub const ERR_INVALID: i32 = -6;
pub const ERR_BAD_HANDLE: i32 = -9;
pub const ERR_UTF8: i32 = -10;

fn status_of(e: &boxsh_fs::Error) -> i32 {
    use boxsh_fs::Error as E;
    match e {
        E::NotFound => ERR_NOT_FOUND,
        E::Exists => -2,
        E::NotDir => -3,
        E::IsDir => ERR_IS_DIR,
        E::NotEmpty => -5,
        E::Invalid => ERR_INVALID,
        E::Io(_) => -7,
        E::Corrupt(_) => -8,
    }
}

struct SandboxState {
    fs: MemoryBackend,
    session: Session,
}

static REGISTRY: Mutex<Vec<Option<SandboxState>>> = Mutex::new(Vec::new());

fn default_session() -> Session {
    let mut session = Session::new();
    session.env = Env::from_iter([
        ("HOME", "/"),
        ("USER", "agent"),
        ("PATH", "/usr/local/bin:/usr/bin:/bin"),
        ("TERM", "xterm-256color"),
        ("SHELL", "/bin/bash"),
        ("LANG", "C.UTF-8"),
    ]);
    session
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_state<T>(
    handle: i32,
    f: impl FnOnce(&mut SandboxState) -> Result<T, i32>,
) -> Result<T, i32> {
    let mut registry = REGISTRY.lock().expect("registry poisoned");
    let state = usize::try_from(handle)
        .ok()
        .and_then(|i| registry.get_mut(i))
        .and_then(Option::as_mut)
        .ok_or(ERR_BAD_HANDLE)?;
    f(state)
}

/// A shell-visible backend over the shared filesystem: borrows per call so
/// the command runner and the shell can both reach it during a script.
struct SharedBackend(Rc<RefCell<MemoryBackend>>);

impl Backend for SharedBackend {
    fn kind_name(&self) -> &'static str {
        "ffi"
    }
    fn read(&mut self, path: &str) -> boxsh_fs::Result<Vec<u8>> {
        self.0.borrow_mut().read(path)
    }
    fn write(&mut self, path: &str, data: &[u8]) -> boxsh_fs::Result<()> {
        self.0.borrow_mut().write(path, data)
    }
    fn entry(&mut self, path: &str) -> boxsh_fs::Result<Option<Entry>> {
        self.0.borrow_mut().entry(path)
    }
    fn list(&mut self, path: &str) -> boxsh_fs::Result<Vec<String>> {
        self.0.borrow_mut().list(path)
    }
    fn mkdir(&mut self, path: &str) -> boxsh_fs::Result<()> {
        self.0.borrow_mut().mkdir(path)
    }
    fn remove(&mut self, path: &str) -> boxsh_fs::Result<()> {
        self.0.borrow_mut().remove(path)
    }
    fn rename(&mut self, from: &str, to: &str) -> boxsh_fs::Result<()> {
        self.0.borrow_mut().rename(from, to)
    }
    fn flush(&mut self) -> boxsh_fs::Result<()> {
        Ok(())
    }
}

struct NativeRunner(Rc<RefCell<MemoryBackend>>);

impl CommandRunner for NativeRunner {
    fn knows(&self, name: &str) -> bool {
        boxsh_commands::knows(name)
    }

    fn run(&mut self, argv: &[String], stdin: &[u8], session: &Session) -> CommandOutput {
        let mut backend = SharedBackend(Rc::clone(&self.0));
        match boxsh_commands::run(&mut backend, &session.cwd, argv, stdin) {
            Some(o) => CommandOutput {
                out: o.out,
                err: o.err,
                code: o.code,
            },
            None => CommandOutput {
                out: Vec::new(),
                err: Vec::new(),
                code: 127,
            },
        }
    }
}

/// An owned byte buffer crossing the C boundary; free with `boxsh_buf_free`.
#[repr(C)]
pub struct BoxshBuf {
    pub ptr: *mut u8,
    pub len: usize,
}

fn emit(out: *mut BoxshBuf, bytes: Vec<u8>) {
    let buf = if bytes.is_empty() {
        BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        }
    } else {
        let boxed = bytes.into_boxed_slice();
        let len = boxed.len();
        BoxshBuf {
            ptr: Box::into_raw(boxed) as *mut u8,
            len,
        }
    };
    unsafe { out.write(buf) }
}

/// # Safety
/// `buf` must come from this library and not have been freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_buf_free(buf: BoxshBuf) {
    if !buf.ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(buf.ptr, buf.len, buf.len) });
    }
}

unsafe fn bytes_arg<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(ptr, len) }
    }
}

unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str, i32> {
    core::str::from_utf8(unsafe { bytes_arg(ptr, len) }).map_err(|_| ERR_UTF8)
}

/// Create a sandbox (filesystem + shell session) and return its handle.
#[unsafe(no_mangle)]
pub extern "C" fn boxsh_sandbox_new() -> i32 {
    let state = SandboxState {
        fs: MemoryBackend::new(),
        session: default_session(),
    };
    let mut registry = REGISTRY.lock().expect("registry poisoned");
    match registry.iter().position(Option::is_none) {
        Some(i) => {
            registry[i] = Some(state);
            i32::try_from(i).expect("handle fits in i32")
        }
        None => {
            registry.push(Some(state));
            i32::try_from(registry.len() - 1).expect("handle fits in i32")
        }
    }
}

/// Release a sandbox.
#[unsafe(no_mangle)]
pub extern "C" fn boxsh_sandbox_free(handle: i32) -> i32 {
    let mut registry = REGISTRY.lock().expect("registry poisoned");
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
}

/// Set or overwrite a session environment variable.
///
/// # Safety
/// `key`/`value` must be valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_set_env(
    handle: i32,
    key: *const u8,
    key_len: usize,
    value: *const u8,
    value_len: usize,
) -> i32 {
    let (k, v) = match (unsafe { str_arg(key, key_len) }, unsafe {
        str_arg(value, value_len)
    }) {
        (Ok(k), Ok(v)) => (k.to_string(), v.to_string()),
        _ => return ERR_UTF8,
    };
    match with_state(handle, |s| {
        s.session.env.set(&k, &v);
        Ok(())
    }) {
        Ok(()) => OK,
        Err(code) => code,
    }
}

/// Run a shell script. Returns the exit code (>= 0) or a negative status.
/// The session (env, cwd, `$?`) persists on the handle across calls.
///
/// # Safety
/// `script` must be valid for `script_len` bytes; `out`/`err` must each be
/// valid for one `BoxshBuf` write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_exec(
    handle: i32,
    script: *const u8,
    script_len: usize,
    out: *mut BoxshBuf,
    err: *mut BoxshBuf,
) -> i32 {
    let script = match unsafe { str_arg(script, script_len) } {
        Ok(s) => s.to_string(),
        Err(code) => return code,
    };

    // Take the state out so the registry lock is not held during execution.
    let taken = {
        let mut registry = REGISTRY.lock().expect("registry poisoned");
        match usize::try_from(handle)
            .ok()
            .and_then(|i| registry.get_mut(i))
        {
            Some(slot) if slot.is_some() => slot.take().expect("checked"),
            _ => return ERR_BAD_HANDLE,
        }
    };
    let SandboxState {
        mut fs,
        mut session,
    } = taken;
    fs.set_time(now_ms());

    let shared = Rc::new(RefCell::new(fs));
    let mut backend = SharedBackend(Rc::clone(&shared));
    let mut runner = NativeRunner(Rc::clone(&shared));
    let result = exec_script(&mut backend, &mut runner, &mut session, &script);
    drop(backend);
    drop(runner);
    let fs = Rc::try_unwrap(shared)
        .expect("no outstanding borrows")
        .into_inner();

    REGISTRY.lock().expect("registry poisoned")[usize::try_from(handle).expect("checked")] =
        Some(SandboxState { fs, session });

    emit(out, result.stdout);
    emit(err, result.stderr);
    result.code
}

/// Read a file. Returns 0 and fills `out`, or a negative status.
///
/// # Safety
/// `path` must be valid for `path_len` bytes; `out` for one `BoxshBuf`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_read_file(
    handle: i32,
    path: *const u8,
    path_len: usize,
    out: *mut BoxshBuf,
) -> i32 {
    let path = match unsafe { str_arg(path, path_len) } {
        Ok(p) => boxsh_fs::normalize(p),
        Err(code) => return code,
    };
    match with_state(handle, |s| s.fs.read(&path).map_err(|e| status_of(&e))) {
        Ok(data) => {
            emit(out, data);
            OK
        }
        Err(code) => code,
    }
}

/// Create or overwrite a file, creating parent directories.
///
/// # Safety
/// `path`/`data` must be valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_write_file(
    handle: i32,
    path: *const u8,
    path_len: usize,
    data: *const u8,
    data_len: usize,
) -> i32 {
    let path = match unsafe { str_arg(path, path_len) } {
        Ok(p) => boxsh_fs::normalize(p),
        Err(code) => return code,
    };
    let bytes = unsafe { bytes_arg(data, data_len) };
    let r = with_state(handle, |s| {
        s.fs.set_time(now_ms());
        let mut at = String::new();
        for seg in path
            .split('/')
            .rev()
            .skip(1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            if !at.is_empty() {
                at.push('/');
            }
            at.push_str(seg);
            if s.fs.entry(&at).map_err(|e| status_of(&e))?.is_none() {
                s.fs.mkdir(&at).map_err(|e| status_of(&e))?;
            }
        }
        s.fs.write(&path, bytes).map_err(|e| status_of(&e))
    });
    match r {
        Ok(()) => OK,
        Err(code) => code,
    }
}

/// The whole filesystem as a tar archive.
///
/// # Safety
/// `out` must be valid for one `BoxshBuf` write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_export_tar(handle: i32, out: *mut BoxshBuf) -> i32 {
    match with_state(handle, |s| {
        boxsh_fs::tar::export(&mut s.fs).map_err(|e| status_of(&e))
    }) {
        Ok(archive) => {
            emit(out, archive);
            OK
        }
        Err(code) => code,
    }
}

/// Merge a tar archive into the filesystem.
///
/// # Safety
/// `tar` must be valid for `tar_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxsh_sandbox_import_tar(
    handle: i32,
    tar: *const u8,
    tar_len: usize,
) -> i32 {
    let archive = unsafe { bytes_arg(tar, tar_len) };
    match with_state(handle, |s| {
        s.fs.set_time(now_ms());
        boxsh_fs::tar::import(&mut s.fs, archive).map_err(|e| status_of(&e))
    }) {
        Ok(()) => OK,
        Err(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(buf: &BoxshBuf) -> Vec<u8> {
        if buf.len == 0 {
            return Vec::new();
        }
        let v = unsafe { core::slice::from_raw_parts(buf.ptr, buf.len) }.to_vec();
        unsafe {
            boxsh_buf_free(BoxshBuf {
                ptr: buf.ptr,
                len: buf.len,
            })
        };
        v
    }

    fn exec(h: i32, script: &str) -> (String, String, i32) {
        let mut out = BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        };
        let mut err = BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        };
        let code =
            unsafe { boxsh_sandbox_exec(h, script.as_ptr(), script.len(), &mut out, &mut err) };
        (
            String::from_utf8(take(&out)).unwrap(),
            String::from_utf8(take(&err)).unwrap(),
            code,
        )
    }

    #[test]
    fn full_session_through_the_c_abi() {
        let h = boxsh_sandbox_new();
        let (out, _, code) = exec(h, "echo hello from $USER");
        assert_eq!((out.as_str(), code), ("hello from agent\n", 0));

        exec(h, "export N=42 && cd /");
        let (out, _, _) = exec(h, "echo $N");
        assert_eq!(out, "42\n");

        exec(h, "seq 1 5 > /nums.txt");
        let (out, _, _) = exec(h, "cat /nums.txt | head -2 | sort -r");
        assert_eq!(out, "2\n1\n");

        // Unknown (cold-tier) commands are 127 here, not a crash.
        let (_, err, code) = exec(h, "ls /");
        assert_eq!(code, 127);
        assert!(err.contains("command not found"), "{err}");

        assert_eq!(boxsh_sandbox_free(h), OK);
        assert_eq!(boxsh_sandbox_free(h), ERR_BAD_HANDLE);
    }

    #[test]
    fn files_and_tar_through_the_c_abi() {
        let h = boxsh_sandbox_new();
        let path = "deep/dir/f.txt";
        let data = b"native bytes \x00\xff";
        let s = unsafe {
            boxsh_sandbox_write_file(h, path.as_ptr(), path.len(), data.as_ptr(), data.len())
        };
        assert_eq!(s, OK);
        let mut out = BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        };
        assert_eq!(
            unsafe { boxsh_sandbox_read_file(h, path.as_ptr(), path.len(), &mut out) },
            OK
        );
        assert_eq!(take(&out), data);

        let mut tar = BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        };
        assert_eq!(unsafe { boxsh_sandbox_export_tar(h, &mut tar) }, OK);
        let archive = take(&tar);

        let h2 = boxsh_sandbox_new();
        assert_eq!(
            unsafe { boxsh_sandbox_import_tar(h2, archive.as_ptr(), archive.len()) },
            OK
        );
        let mut out2 = BoxshBuf {
            ptr: core::ptr::null_mut(),
            len: 0,
        };
        assert_eq!(
            unsafe { boxsh_sandbox_read_file(h2, path.as_ptr(), path.len(), &mut out2) },
            OK
        );
        assert_eq!(take(&out2), data);
        boxsh_sandbox_free(h);
        boxsh_sandbox_free(h2);
    }
}
