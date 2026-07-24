# nobox playground

A browser tab pretending to be a machine: 73 GNU coreutils (ported from
[uutils](https://github.com/uutils/coreutils), compiled to `wasm32-wasip1`,
zero lines modified) running against an in-page virtual filesystem, behind a
minimal shell parser.

## Run it

```sh
# 1. build the multicall wasm (once, ~2 min)
cd examples/playground/coreutils-demo
cargo build --release --target wasm32-wasip1

# 2. serve the repo root (any static server works)
cd ../../..
python3 -m http.server 8420

# 3. open
open http://localhost:8420/examples/playground/
```

## What is real and what is not (yet)

| Real today | Coming |
|---|---|
| The 73 commands are genuinely ported binaries executing WASI syscalls | grep/sed/find/awk — native, milestone M4 |
| Pipes, redirects, `&& \|\| ;`, quotes, `$VARS`, `cd` (shell-level) | Real bash grammar — brush-parser + our evaluator, M3 |
| Filesystem semantics: mkdir/mv/cp/rm/ls -la, mtimes, `..` resolution | Block-based VFS with A/B-commit durability — M1 |
| State persists across commands | State persists across *refresh* — OPFS backend, M2 |

The WASI shim in `shell.js` (~250 lines) is the architectural ancestor of
nobox's real syscall layer: same seam, same trick — commands think they're
talking to an OS; the OS is whatever we say it is.
