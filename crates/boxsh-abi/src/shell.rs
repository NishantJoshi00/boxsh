//! Shell exports: boxsh-shell behind the ABI.
//!
//! `boxsh_shell_exec` runs a script against a filesystem handle from
//! [`crate::fs`]. The session (env, cwd, last status) crosses the boundary
//! on every call — the host owns its presentation, Rust owns the semantics —
//! so there is no session registry to manage.
//!
//! Commands execute through the host: the `boxsh_host` import module
//! (`host_command_knows` / `host_command_run`), present only when the
//! `host-commands` feature is on. The feature exists because a module with
//! host imports cannot instantiate under a plain WASI runner — test builds
//! (both targets) leave it off and use a registry runner instead; artifact
//! builds turn it on.
//!
//! Re-entrancy rule: while a script runs, commands re-enter this module
//! through the `boxsh_fs_*` exports (their WASI syscalls are shimmed onto
//! the same filesystem). The shell therefore borrows the filesystem
//! registry per operation — never across a command invocation.
//!
//! Encodings (shared with `fs`): argv and env cross as u32-length-prefixed
//! lists; env entries are `KEY=VALUE`. The out cell is four
//! pointer-width-word pairs: stdout, stderr, env, cwd — all host-freed via
//! `boxsh_free`. The return value is the script's exit code, or a negative
//! fs-status on invalid input.

use boxsh_fs::{Backend, Entry, Error, Result as FsResult};
use boxsh_shell::{CommandOutput, CommandRunner, Env, Session, exec_script};

use crate::fs::{ERR_BAD_HANDLE, emit, encode_path_list, str_arg, with_fs};

/// A [`Backend`] over a registry handle that borrows per call, so command
/// re-entry through the fs exports never overlaps a live borrow.
struct RegistryBackend {
    handle: i32,
}

fn registry_gone() -> Error {
    Error::Io("filesystem handle closed during execution".to_string())
}

impl Backend for RegistryBackend {
    fn kind_name(&self) -> &'static str {
        "registry"
    }

    fn read(&mut self, path: &str) -> FsResult<Vec<u8>> {
        with_fs(self.handle, |fs| fs.read(path).map_err(status_of)).map_err(restore_err)
    }

    fn write(&mut self, path: &str, data: &[u8]) -> FsResult<()> {
        with_fs(self.handle, |fs| fs.write(path, data).map_err(status_of)).map_err(restore_err)
    }

    fn entry(&mut self, path: &str) -> FsResult<Option<Entry>> {
        with_fs(self.handle, |fs| fs.entry(path).map_err(status_of)).map_err(restore_err)
    }

    fn list(&mut self, path: &str) -> FsResult<Vec<String>> {
        with_fs(self.handle, |fs| fs.list(path).map_err(status_of)).map_err(restore_err)
    }

    fn mkdir(&mut self, path: &str) -> FsResult<()> {
        with_fs(self.handle, |fs| fs.mkdir(path).map_err(status_of)).map_err(restore_err)
    }

    fn remove(&mut self, path: &str) -> FsResult<()> {
        with_fs(self.handle, |fs| fs.remove(path).map_err(status_of)).map_err(restore_err)
    }

    fn rename(&mut self, from: &str, to: &str) -> FsResult<()> {
        with_fs(self.handle, |fs| fs.rename(from, to).map_err(status_of)).map_err(restore_err)
    }

    fn flush(&mut self) -> FsResult<()> {
        Ok(())
    }
}

/// Ferry a typed error through `with_fs`'s status channel and back.
fn status_of(e: Error) -> i32 {
    // Encode the discriminant; `restore_err` rebuilds an equivalent error.
    crate::fs::status_code(&e)
}

fn restore_err(code: i32) -> Error {
    match code {
        crate::fs::ERR_NOT_FOUND => Error::NotFound,
        crate::fs::ERR_EXISTS => Error::Exists,
        crate::fs::ERR_NOT_DIR => Error::NotDir,
        crate::fs::ERR_IS_DIR => Error::IsDir,
        crate::fs::ERR_NOT_EMPTY => Error::NotEmpty,
        crate::fs::ERR_INVALID => Error::Invalid,
        ERR_BAD_HANDLE => registry_gone(),
        _ => Error::Io(format!("filesystem error {code}")),
    }
}

// --- command execution through the host -----------------------------------

#[cfg(all(target_arch = "wasm32", feature = "host-commands"))]
mod host {
    use super::*;

    #[link(wasm_import_module = "boxsh_host")]
    unsafe extern "C" {
        fn host_command_knows(name: *const u8, name_len: usize) -> i32;
        /// Writes four little-endian u32s into `cell`: stdout ptr/len and
        /// stderr ptr/len, allocated by the host via `boxsh_alloc` (this
        /// module reclaims them). Returns the exit code. `env` is a
        /// path-list of `KEY=VALUE` pairs and `cwd` the absolute working
        /// directory — the live session at this moment, so mid-script `cd`
        /// and `export` reach host-executed commands too.
        fn host_command_run(
            argv: *const u8,
            argv_len: usize,
            stdin: *const u8,
            stdin_len: usize,
            env: *const u8,
            env_len: usize,
            cwd: *const u8,
            cwd_len: usize,
            cell: *mut u8,
        ) -> i32;
    }

    pub struct HostRunner;

    impl CommandRunner for HostRunner {
        fn knows(&self, name: &str) -> bool {
            unsafe { host_command_knows(name.as_ptr(), name.len()) != 0 }
        }

        fn run(&mut self, argv: &[String], stdin: &[u8], session: &Session) -> CommandOutput {
            let blob = encode_path_list(argv);
            let env: Vec<String> = session
                .env
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            let env_blob = encode_path_list(&env);
            let mut cell = [0u8; 16];
            let code = unsafe {
                host_command_run(
                    blob.as_ptr(),
                    blob.len(),
                    stdin.as_ptr(),
                    stdin.len(),
                    env_blob.as_ptr(),
                    env_blob.len(),
                    session.cwd.as_ptr(),
                    session.cwd.len(),
                    cell.as_mut_ptr(),
                )
            };
            let word = |at: usize| {
                u32::from_le_bytes(cell[at..at + 4].try_into().expect("cell slice")) as usize
            };
            let take = |ptr: usize, len: usize| -> Vec<u8> {
                if len == 0 {
                    Vec::new()
                } else {
                    // Host allocated exactly `len` via boxsh_alloc.
                    unsafe { Vec::from_raw_parts(ptr as *mut u8, len, len) }
                }
            };
            CommandOutput {
                out: take(word(0), word(4)),
                err: take(word(8), word(12)),
                code,
            }
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", feature = "host-commands")))]
mod host {
    use super::*;
    use std::cell::RefCell;

    type NativeRunner = Box<dyn FnMut(&[String], &[u8]) -> Option<CommandOutput>>;

    thread_local! {
        static RUNNER: RefCell<Option<NativeRunner>> = const { RefCell::new(None) };
    }

    /// Install a command runner for builds without host imports (tests).
    /// The closure returns `None` for unknown commands.
    pub fn set_test_runner(runner: NativeRunner) {
        RUNNER.with(|r| *r.borrow_mut() = Some(runner));
    }

    pub struct HostRunner;

    impl CommandRunner for HostRunner {
        fn knows(&self, name: &str) -> bool {
            let argv = [name.to_string()];
            RUNNER.with(|r| {
                r.borrow_mut()
                    .as_mut()
                    .is_some_and(|f| f(&argv, b"\0probe").is_some())
            })
        }

        fn run(&mut self, argv: &[String], stdin: &[u8], _session: &Session) -> CommandOutput {
            RUNNER.with(|r| {
                r.borrow_mut()
                    .as_mut()
                    .and_then(|f| f(argv, stdin))
                    .unwrap_or(CommandOutput {
                        out: Vec::new(),
                        err: Vec::new(),
                        code: 127,
                    })
            })
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", feature = "host-commands")))]
pub use host::set_test_runner;

/// The command router: in-module commands first (boxsh-commands, running
/// directly on the filesystem — no boundary), the host engine for the rest
/// (the uutils multicall module).
struct SandboxRunner {
    handle: i32,
    host: host::HostRunner,
}

impl CommandRunner for SandboxRunner {
    fn knows(&self, name: &str) -> bool {
        boxsh_commands::knows(name) || self.host.knows(name)
    }

    fn run(&mut self, argv: &[String], stdin: &[u8], session: &Session) -> CommandOutput {
        let name = argv.first().map(String::as_str).unwrap_or("");
        if boxsh_commands::knows(name) {
            let mut backend = RegistryBackend {
                handle: self.handle,
            };
            if let Some(o) = boxsh_commands::run(&mut backend, &session.cwd, argv, stdin) {
                return CommandOutput {
                    out: o.out,
                    err: o.err,
                    code: o.code,
                };
            }
        }
        self.host.run(argv, stdin, session)
    }
}

// --- the export ------------------------------------------------------------

/// Run a script. See the module docs for the calling convention.
///
/// # Safety
/// All (ptr, len) inputs must be valid; `out` must be valid for four
/// pointer-width word pairs.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn boxsh_shell_exec(
    fs_handle: i32,
    env: *const u8,
    env_len: usize,
    cwd: *const u8,
    cwd_len: usize,
    last_status: i32,
    script: *const u8,
    script_len: usize,
    out: *mut u8,
) -> i32 {
    let parsed = (|| {
        let env_blob = unsafe { crate::fs::bytes_arg(env, env_len) };
        let cwd = unsafe { str_arg(cwd, cwd_len) }?;
        let script = unsafe { str_arg(script, script_len) }?;
        Ok::<_, i32>((decode_env(env_blob)?, cwd, script))
    })();
    let (env, cwd, script) = match parsed {
        Ok(v) => v,
        Err(code) => return code,
    };

    // The handle must exist up front; individual ops re-check per call.
    if with_fs(fs_handle, |_| Ok(())).is_err() {
        return ERR_BAD_HANDLE;
    }

    let mut session = Session {
        env,
        cwd: cwd.to_string(),
        last_status,
    };
    let mut backend = RegistryBackend { handle: fs_handle };
    let mut runner = SandboxRunner {
        handle: fs_handle,
        host: host::HostRunner,
    };
    let result = exec_script(&mut backend, &mut runner, &mut session, script);

    let env_out: Vec<String> = session
        .env
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    let word = size_of::<usize>();
    unsafe {
        emit(out, result.stdout);
        emit(out.add(2 * word), result.stderr);
        emit(out.add(4 * word), encode_path_list(&env_out));
        emit(out.add(6 * word), session.cwd.into_bytes());
    }
    result.code
}

fn decode_env(blob: &[u8]) -> Result<Env, i32> {
    let mut env = Env::new();
    let mut at = 0;
    while at < blob.len() {
        if at + 4 > blob.len() {
            return Err(crate::fs::ERR_CORRUPT);
        }
        let len = u32::from_le_bytes(blob[at..at + 4].try_into().expect("length prefix")) as usize;
        at += 4;
        if at + len > blob.len() {
            return Err(crate::fs::ERR_CORRUPT);
        }
        let entry = core::str::from_utf8(&blob[at..at + len]).map_err(|_| crate::fs::ERR_UTF8)?;
        at += len;
        if let Some(eq) = entry.find('=') {
            env.set(&entry[..eq], &entry[eq + 1..]);
        }
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{boxsh_fs_drop, boxsh_fs_new};

    const WORD: usize = size_of::<usize>();

    fn take_words(cell: &[u8], pair: usize) -> Vec<u8> {
        let at = pair * 2 * WORD;
        let ptr = usize::from_le_bytes(cell[at..at + WORD].try_into().unwrap());
        let len = usize::from_le_bytes(cell[at + WORD..at + 2 * WORD].try_into().unwrap());
        if len == 0 {
            return Vec::new();
        }
        let data = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) }.to_vec();
        unsafe { crate::boxsh_free(ptr as *mut u8, len) };
        data
    }

    fn exec(
        h: i32,
        env: &[(&str, &str)],
        cwd: &str,
        script: &str,
    ) -> (String, String, String, String, i32) {
        let env_blob = encode_path_list(
            &env.iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>(),
        );
        let mut cell = [0u8; 8 * WORD];
        let code = unsafe {
            boxsh_shell_exec(
                h,
                env_blob.as_ptr(),
                env_blob.len(),
                cwd.as_ptr(),
                cwd.len(),
                0,
                script.as_ptr(),
                script.len(),
                cell.as_mut_ptr(),
            )
        };
        let s = |v: Vec<u8>| String::from_utf8(v).unwrap();
        (
            s(take_words(&cell, 0)),
            s(take_words(&cell, 1)),
            s(take_words(&cell, 2)),
            s(take_words(&cell, 3)),
            code,
        )
    }

    fn install_echo_runner() {
        set_test_runner(Box::new(|argv, stdin| match argv[0].as_str() {
            "echo" => Some(CommandOutput {
                out: format!("{}\n", argv[1..].join(" ")).into_bytes(),
                err: Vec::new(),
                code: 0,
            }),
            "cat" if stdin != b"\0probe" => Some(CommandOutput {
                out: stdin.to_vec(),
                err: Vec::new(),
                code: 0,
            }),
            "cat" => Some(CommandOutput {
                out: Vec::new(),
                err: Vec::new(),
                code: 0,
            }),
            _ => None,
        }));
    }

    #[test]
    fn script_runs_against_a_filesystem_handle() {
        install_echo_runner();
        let h = boxsh_fs_new();
        let (out, err, _, _, code) = exec(
            h,
            &[("USER", "agent")],
            "/",
            "echo hi $USER > /f.txt\ncat < /f.txt",
        );
        assert_eq!(code, 0, "{err}");
        assert_eq!(out, "hi agent\n");
        // The write landed in the shared filesystem.
        let mut cell = [0u8; 16];
        let s = unsafe { crate::fs::boxsh_fs_read(h, "f.txt".as_ptr(), 5, cell.as_mut_ptr()) };
        assert_eq!(s, 0);
        assert_eq!(boxsh_fs_drop(h), 0);
    }

    #[test]
    fn session_round_trips_env_and_cwd() {
        install_echo_runner();
        let h = boxsh_fs_new();
        unsafe {
            assert_eq!(crate::fs::boxsh_fs_mkdir(h, "dir".as_ptr(), 3), 0);
        }
        let (_, _, env, cwd, code) = exec(h, &[("HOME", "/")], "/", "export NEW=value && cd /dir");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/dir");
        assert!(env.contains("NEW=value"), "{env}");
        assert!(env.contains("HOME=/"), "{env}");
        assert_eq!(boxsh_fs_drop(h), 0);
    }

    #[test]
    fn unknown_commands_and_bad_handles() {
        install_echo_runner();
        let h = boxsh_fs_new();
        let (_, err, _, _, code) = exec(h, &[], "/", "missing-command");
        assert_eq!(code, 127);
        assert!(err.contains("command not found"));
        assert_eq!(boxsh_fs_drop(h), 0);
        let (_, _, _, _, code) = exec(h, &[], "/", "echo hi");
        assert_eq!(code, ERR_BAD_HANDLE);
    }
}
