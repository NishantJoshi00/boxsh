# Embedding boxsh outside the browser

The sandbox — filesystem, shell, and the in-module command tier — is Rust.
Two embedding paths expose it beyond the JavaScript package:

## Wasm embedding (isolation preserved)

Run the same `engine/fs.wasm` browsers use, inside any wasm runtime. The
sandbox stays sandboxed: a buggy or hostile command cannot touch the host.

A complete, runnable host lives at `examples/embedding/wasmtime-host`
(Rust + wasmtime; `cargo run --release` after building the module). The
same shape ports to Python (`wasmtime` on PyPI), Go (`wasmtime-go`), .NET,
or Ruby — each is the ~150 lines in that example:

1. Satisfy the module's imports: seven `wasi_snapshot_preview1` functions
   (environ ×2, `proc_exit`, `sched_yield`, `random_get`,
   `clock_time_get`, `fd_write` for panic output) and three `boxsh_host`
   functions (`host_command_knows`/`host_command_run` — return 0/127 if
   you don't attach a cold-command engine — and `host_fs_dirty`, the
   persistence signal).
2. Call the exports: `boxsh_fs_new()` for a filesystem handle, then
   `boxsh_shell_exec(fs, env, envLen, cwd, cwdLen, lastStatus, script,
   scriptLen, outCell)`. Strings cross as (ptr, len) staged via
   `boxsh_alloc`; the 32-byte out cell returns four (ptr, len) u32 pairs —
   stdout, stderr, env, cwd — each freed with `boxsh_free`. Env crosses as
   u32-length-prefixed `KEY=VALUE` entries; keep the returned env/cwd and
   pass them back to persist the session.
3. Persistence: hydrate with `boxsh_fs_restore` per entry at open; drain
   `boxsh_fs_take_dirty` (resolving each path via `boxsh_fs_entry` +
   `boxsh_fs_read`) whenever `host_fs_dirty` fires. Or snapshot whole
   workspaces with `boxsh_fs_export_tar` / `boxsh_fs_import_tar`.

## Native FFI (in-process)

`crates/boxsh-ffi` builds a `cdylib` with a C ABI — `include/boxsh.h` has
the declarations — for hosts that want the sandbox semantics without a
wasm runtime: Python `ctypes`/`cffi`, Go `cgo`, anything with C FFI.

```c
int32_t h = boxsh_sandbox_new();
boxsh_buf out, err;
int32_t code = boxsh_sandbox_exec(h, script, script_len, &out, &err);
boxsh_buf_free(out); boxsh_buf_free(err);
boxsh_sandbox_free(h);
```

Sessions persist on the handle; `boxsh_sandbox_read_file`/`write_file`
give direct access, and `export_tar`/`import_tar` snapshot workspaces.
The in-module command tier (echo, cat, tee, wc, seq, head, sort, grep,
true, false) plus all shell builtins are available; the uutils cold tier
is a wasm-host feature, so unknown commands exit 127. Note what this path
trades away: the code runs in your process — sandboxed in behavior (it
can only touch its virtual filesystem) but not in the isolation sense.
Prefer the wasm embedding for untrusted workloads.

Rust hosts skip the C layer: depend on `boxsh-fs`/`boxsh-shell`/
`boxsh-commands` directly, and add `crates/boxsh-store-sqlite` for
SQL-backed persistence over the same replication contract.
