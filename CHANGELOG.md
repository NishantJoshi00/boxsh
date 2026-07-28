# Changelog

## 0.2.1 — 2026-07-28

### Fixed

- In-module commands now decline flags they don't implement so the shell
  falls through to the full uutils implementations, instead of erroring
  (`grep -E`) or silently misbehaving (`sort -n` sorted
  lexicographically; `wc -m`, `head -c`, `echo -e`, `cat -n` and similar
  were affected the same way).
- In-module `grep` gains `-E` (a no-op — its engine is ERE-shaped
  already) and `-o` (only-matching), so the most common variants stay on
  the fast path.
- The native FFI reports "unsupported usage" for declined invocations
  rather than a bare 127 (it has no uutils tier to fall through to).

## 0.2.0 — 2026-07-28

The sandbox is Rust now. The filesystem, the shell, and the hot-path
commands all live inside one wasm module; TypeScript is reduced to
loading, host glue, and persistence adapters.

### Added

- **Persistent backends**: `indexeddb()` and `opfs()` — the working tree
  lives in the Rust filesystem and replicates write-behind (single
  IndexedDB transaction per drain; real OPFS file tree with an mtime
  sidecar). Web Lock tab exclusivity, format-version guards,
  `destroyIndexedDBFilesystem`/`destroyOpfsFilesystem`.
- **`wasmMemory()`**: the non-persistent Rust-filesystem backend — the
  standard choice, replacing `memory()` as the default recommendation.
- **`tarfile()`**: open a workspace from a tar archive, get the updated
  archive back on flush; `Filesystem.export()/import()` now use the
  in-module Rust ustar codec on wasm backends.
- **In-module commands**: true, false, echo, cat, tee, wc, seq, head,
  sort, grep execute inside the sandbox module directly on the
  filesystem — no boundary. Exec overhead is ~14 µs/command, 12–15×
  faster than JS shell interpreters.
- **Rust-initiated persistence push**: the module signals the host when
  replication work exists, so shell/command writes persist without
  polling or explicit flushes.
- **Native embedding**: `crates/boxsh-ffi` (C ABI cdylib +
  `include/boxsh.h`) and a verified wasmtime host example
  (`examples/embedding/wasmtime-host`); `crates/boxsh-store-sqlite`
  persists the filesystem in queryable SQLite. See docs/embedding.md.
- Playwright browser test suite for the persistent backends; per-runtime
  benchmarks under `bench/` (browser, node, bun, native rust).

### Changed (breaking)

- `Sandbox` requires a wasm-backed filesystem (`wasmMemory`, `indexeddb`,
  `opfs`, or `tarfile`); `memory()` remains for direct `Filesystem` use.
- The shell moved to Rust (`boxsh_shell_exec`), with deliberate fixes:
  `>>` actually appends, `\$` in double quotes stays literal, stderr from
  `$( )` substitutions propagates, mid-script `cd`/`export` reach every
  command.
- `loadEngine`'s `optimizedCommands` is accepted but ignored;
  `engine/commands-optimized.wasm` is no longer shipped (the optimized
  tier lives inside `engine/fs.wasm`).

## 0.1.1

Initial public release: TypeScript shell and in-memory filesystem, wasm
coreutils (cold multicall + hot reactor), tar import/export.
