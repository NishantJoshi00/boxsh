# nobox V0 Plan

**Date:** 2026-07-23
**Status:** reviewed; superseded in part by [decisions.md](decisions.md)
(target is now wasm32-wasip1, utilities ported from uutils, shell =
brush-parser + our evaluator, backends = memory/OPFS/IndexedDB, name =
nobox). Where the two disagree, decisions.md wins.
**Driving principle:** Occam's razor — every concept must fight for its existence.

## What nobox is

A **fake sandbox** for AI agents: a virtual filesystem plus a bash-compatible
interpreter with WASM-optimized utilities, compiled to a single
`wasm32-unknown-unknown` module and assembled from TypeScript. It runs wherever
WASM runs and deliberately does not know where it is running. Storage is a
pluggable block store; sandbox state is (eventually) a portable image.

V0 proves it in the browser. Nothing in the core may assume a browser.

**Positioning (from competitive research, 2026-07-23):**
- Do not compete on interpreter breadth or raw native speed (bashkit owns both).
- Compete on: **persistence** (no shell player has OPFS/IndexedDB — verified),
  **browser-first WASM optimization** (bashkit's WASM build is an afterthought;
  nobody publishes browser benchmarks), **binary-safe I/O** (both leaders have
  string-boundary corruption bugs), **permissive license** (MIT OR Apache-2.0).

## Public API (V0) — two objects, that's it

```ts
import { Filesystem, Sandbox, opfs, memory } from "nobox";

// 1. the filesystem — owns data
const fs = await Filesystem({ backend: opfs("workspace.img") });

// 2. the sandbox — owns the session; what you hand to an agent
const sb = new Sandbox({ fs });               // commands default: coreutils + bash
const r  = await sb.exec("grep -r TODO src | wc -l");  // {stdout, stderr, code}
await sb.exec("export FOO=1; cd src");        // env and cwd persist across calls

// filesystem is independently useful (no sandbox needed)
await fs.writeFile("/a.txt", bytes);          // Uint8Array in/out
await fs.switchBackend(indexeddb("ws"));      // live block-level migration
const tar = await fs.export();                // portable egress
```

Ownership:
- **`Filesystem`**: data + durability. `readFile / writeFile / readdir / stat /
  mkdir / rm / rename / flush / export / import / switchBackend`. Capped small;
  every new method fights for its life. Usable standalone (the ZenFS-
  replacement audience stops here).
- **`Sandbox`**: session + execution. Holds env, cwd, command set; `exec()`
  buffered now, `spawn()` (streaming/abort) reserved for later. Custom
  commands: `commands: [...coreutils, mine]` at construction (tree-shakeable).
  Two sandboxes may share one fs; a sandbox is disposable, the fs is not.
- **`bash` is a command**, not a layer — it implements the same command
  interface as `ls`, with its parser/evaluator internal to it. `sh script.sh`,
  `bash -c`, and nested `bash -c 'bash -c ...'` fall out for free. (Honest
  note: this relocates the parser work, it does not remove it.)
- **`switchBackend`** = quiesce → copy blocks → flip active store → flush.
  One-way migration, not sync. It is also, quietly, the future cloud-push
  primitive.

## V0 scope

**In:**
- `nobox-core` VFS with versioned on-disk format over a 4-method BlockStore
- Backends: in-memory (Rust) and OPFS (TS, sync access handles in a Worker)
- The `bash` command: agent-emitted subset (grammar in M3)
- ~30 tier-1 utilities, streaming, fused pipelines, `Uint8Array`-safe
- The two-object TS API above, incl. `switchBackend`
- tar import/export (also the folder-upload story: File System Access API →
  tar-like stream → importer)
- Persistence demo: workspace survives refresh
- Published, reproducible benchmarks + compat score vs just-bash and
  bashkit-wasm

**Out of V0 — but the skeleton must not block it:**
- IndexedDB / SQLite / Postgres / S3 / http-readonly backends
- Native (non-WASM) build and cloud continuity ("same image, two runtimes")
- Sandbox image sharing, snapshot/diff/audit, journaled replay (Temporal-style
  resumable agent execution)
- git, mountable interpreters (python/node), multi-tab concurrency
- awk beyond a minimal subset; arrays; process substitution
- `spawn()` streaming exec; `sandbox.tool()` (ready-made agent tool definition)

## Architecture invariants (the future-proofing rules)

These are the load-bearing decisions. Violating one is a design regression,
not a shortcut:

1. **Everything above BlockStore is pure, synchronous, deterministic.** No
   ambient I/O, clocks, randomness, or JS calls in `nobox-core`/`nobox-utils`.
   Environment enters only through injected interfaces (`BlockStore`, `Clock`,
   `Rng`, host stdio). This is what makes the native build and deterministic
   replay possible later without a rewrite.
2. **BlockStore stays tiny:** `read_block / write_block / block_count / flush`.
   Fixed 4 KiB blocks. Implementable from the host side (TS) or in Rust.
   Every proposed fifth method needs a written justification.
3. **On-disk format is versioned from day one** (magic + version in the
   superblock) and **declared unstable until v1**. Atomicity via double
   superblock (A/B commit), not full journaling — the journal slot is reserved
   in the layout for later.
4. **A command is `fn(&mut Ctx) -> i32`** where `Ctx` carries argv, env, cwd,
   stdin/stdout/stderr streams, and a VFS handle. Built-ins, tier-1 utils,
   JS-registered commands, and **bash itself** all use the same interface;
   registered commands are indistinguishable from built-ins (they pipe,
   redirect, glob).
5. **Binary-safe end-to-end.** Bytes, not strings: file contents are
   `Uint8Array` across the JS boundary; paths are bytes. UTF-8 is a display
   concern, never a storage concern.
6. **No COOP/COEP, no SharedArrayBuffer, single-threaded.** Must work in a
   plain `<iframe>`. (Same constraint bashkit chose; it is correct.)
7. **The engine runs inside a dedicated Worker** (required for sync OPFS
   handles); the main-thread `Filesystem`/`Sandbox` objects are a thin async
   RPC client. The Worker side is sync all the way down.
8. **One memory boundary — the JS heap never owns data.** WASM linear
   memory is the sole data plane: bash, utilities, VFS, page cache, and the
   working copy of every block live there. JS is a syscall trampoline, not a
   data owner: OPFS reads/writes operate directly on ephemeral views into
   linear memory (`handle.read(view, {at})`), so block I/O involves zero
   JS-heap copies. Views are constructed per call and never held across
   calls (`memory.grow` detaches them). Bytes enter the JS heap only at
   explicit egress/ingress — `readFile`/`writeFile`/stdout at the public
   API, and Worker↔main postMessage — where a copy is the correct semantic:
   the data is leaving the system. JS-implemented BlockStore backends (a
   later extension point) are the documented exception: they pay the
   crossing per block, which is why V0's backends are in-Rust memory and
   view-based OPFS.

9. **The binding boundary is a C ABI, designed for FFI from day one.**
   Exports are `extern "C"`-shaped: opaque handles, `(ptr, len)` byte
   buffers, integer error codes. No wasm-bindgen types, no closures, no
   host magic at the boundary. WASM is the first host of this ABI (V0); the
   same surface compiles to a `cdylib` later for Bun/Deno FFI, Python
   (ctypes), Go (cgo) — many languages, one contract. Host callbacks (JS
   BlockStore, JS commands) enter as registered imports, not closures.
   Browser-only code sits behind a `wasm` cargo feature.
10. **Dual-target always green.** Every crate — and every command — compiles
    and passes its tests on BOTH `wasm32` and native targets from M0 onward;
    CI runs the matrix on every commit. Backends legitimately differ per
    target (wasm: OPFS/IndexedDB — fast and reliable in a browser; native:
    file/mmap, later Postgres/S3 — the larger arsenal). Command and VFS
    behavior may not differ by even a byte. Target-specific code requires a
    `#[cfg]` plus a comment justifying it.

## Repository layout

```
nobox/
├── Cargo.toml               # workspace
├── crates/
│   ├── nobox-core/            # VFS: superblock, inodes, dirs, fd table,
│   │                        #   page cache, A/B commit. No I/O, no wasm deps.
│   ├── nobox-utils/           # all commands, incl. bash (parser/evaluator as
│   │                        #   internal modules); each cmd behind a cargo
│   │                        #   feature (size budget control)
│   └── nobox-abi/             # the ONLY boundary: C-ABI surface — handles,
│                            #   (ptr,len) buffers, error codes. wasm32 host
│                            #   now (`wasm` feature), cdylib hosts later
├── packages/
│   └── nobox/                 # TS: Filesystem, Sandbox, Worker host, OPFS
│                            #   backend, RPC client, tar import/export, types
├── corpus/                  # harvested agent-emitted commands + expected
│                            #   outputs (the compat spec — see M3)
├── benches/                 # criterion (native) + browser bench harness
├── examples/                # the persistence demo, playground
└── docs/
```

Why crates split this way: `nobox-core` compiles to native for differential
testing today and for the server runtime later; `nobox-abi` quarantines every
host assumption behind one C-style surface; `nobox-utils` features let
embedders drop commands they don't need (bundle size is a browser-market
axis).

## Milestones

Ordering rule: each milestone ends with something runnable and a demo/metric.
M3 and M4 can proceed in parallel after M1.

### M0 — Scaffolding (~0.5 wk)
Workspace, crates, TS package. Raw `wasm32-unknown-unknown` build with
`extern "C"` exports + a hand-written TS loader (~300 lines; no wasm-bindgen
at the boundary — its generated glue hides copies and breaks the C-ABI
contract). CI from day one: fmt, clippy, **test matrix on native AND wasm32**
(native via cargo test; wasm via a Node-hosted harness), **gzip size budget
check** — budget: 3 MB. License files: MIT OR Apache-2.0.

### M1 — VFS core on MemoryStore (~2 wk)
Superblock, inode table, extent-based allocation, directories, path
resolution (incl. `..` and symlink rules), fd table, page cache with dirty
tracking, A/B superblock commit. Ops: open/read/write/seek/truncate/stat/
mkdir/rmdir/unlink/rename(atomic)/symlink/readdir.
**Test strategy:** property tests (proptest) + differential tests against
`std::fs` on native — same op sequence applied to both, states must agree.
Crash-consistency test: kill flush at every block boundary, remount, verify.

### M2 — OPFS backend + Worker host (~1.5 wk)
TS `BlockStore` over `createSyncAccessHandle` in a dedicated Worker; WASM
imports call it synchronously. Main-thread RPC client behind `Filesystem`.
`switchBackend` (quiesce → copy → flip → flush). Web Locks API for
single-writer-per-image (multi-tab correctness = exclusive lock in V0, real
concurrency later). **Gate:** 100 MB workspace — write ≤ 250 ms, reopen
≤ 100 ms, survives refresh; memory→OPFS switch works mid-session.

### M3 — The `bash` command (~2–3 wk)
A command like any other; lexer/parser/evaluator internal to it.
Grammar (the agent subset): pipelines; redirects (`>`, `>>`, `<`, `2>`,
`2>&1`, `&>`); `&&`/`||`/`;`; `$( )` and backticks; globs (`*`, `?`, `[ ]`,
`**`); variables and common `${}` forms; single/double quoting; heredocs;
`if`/`for`/`while`/`case`/functions; `[ ]`/`[[ ]]` common operators;
`$(( ))`. Excluded: job control, interactive features, arrays, process
substitution, extglob (tier-2 list, revisit on corpus evidence).

**Adopted suites are the correctness oracle** — we do not write
shell-semantics tests from scratch:
- **brush's compat suite** (~1,700 cases, MIT): built precisely to diff a
  Rust bash reimplementation against real bash. Vendor it.
- **Oils' spec tests** (Apache-2.0): thousands of cross-shell semantic tests
  pinning down real bash behavior. Vendor the bash-relevant subset.
- **GNU bash's own `tests/`** (GPL-3.0): run-only, fetched at CI time, never
  vendored (license hygiene); filtered to our subset — expect deliberate
  failures on excluded features (job control, interactive).

**The corpus IS the spec** for scope and priority. Harvest real agent-emitted
commands (own Claude Code transcripts as seed; scrub before publishing), run
each under real bash natively, record byte-exact stdout/stderr/exit code, and
differential-test the interpreter against that. Compat becomes a number we
publish, not a claim.
**Gate:** ≥ 95% byte-identical on corpus; every miss is triaged (fix, tier-2,
or won't-support with rationale).

### M4 — Tier-1 utilities (~2–3 wk)
`cat ls cp mv rm mkdir rmdir touch ln stat pwd echo printf head tail wc sort
uniq cut tr grep sed find xargs diff tee basename dirname test chmod env
which date tar` + shell built-ins (`cd export set unset source true false
exit`). awk: minimal subset only (print, field refs, pattern match); full awk
is a tier-2 decision, likely vendoring One True AWK.
Implementation rules: streaming (no whole-file slurps), fused pipelines
(`grep | head` short-circuits), `memchr`/SIMD128 where profiling says it
pays, borrow uutils code where license-compatible rather than rewriting.
**Gate:** corpus compat re-run ≥ 95%; browser microbenches vs just-bash
(target ≥ 5x) and bashkit-wasm (target ≥ parity).

### M5 — TS API + ingress/egress (~1 wk)
The two-object API exactly as specified above, plus tar `export()`/
`import()` and folder upload via File System Access API.
**Gate:** the README quickstart works verbatim; `export FOO=1` persists
across `exec()` calls on one Sandbox; two Sandboxes share one Filesystem
without interference.

### M6 — Hardening, benchmarks, demo (~1 wk)
Fuzz the parser (cargo-fuzz). Publish the bench harness + results (browser,
reproducible — nobody in the field publishes WASM numbers; this is
marketing). Ship the demo: agent runs a task → refresh mid-task → workspace
intact → export as file → import elsewhere. Write the README that leads with
the demo.

**Total: ~10–12 wk part-time solo; materially less with agent-assisted
implementation. M1+M2 (the filesystem) before M3+M4 (the shell) is
deliberate — the FS is the differentiator; the shell is the demo.**

## Success criteria (V0 exit)

1. Compat: ≥ 95% byte-identical on published corpus (number on the README).
2. Persistence: 100 MB workspace; write ≤ 250 ms, reopen ≤ 100 ms; survives
   refresh; tar round-trips losslessly; memory→OPFS switch is lossless.
3. Perf: ≥ 5x just-bash in-browser on pipeline benches; ≥ parity with
   bashkit-wasm; published + reproducible.
4. Size: wasm ≤ 3 MB gzipped with default features.
5. Assembly: quickstart = one npm install + ~6 lines of TS.

## Risks & pre-committed responses

| Risk | Response |
|---|---|
| bashkit ships OPFS persistence | The race we're in. Speed to M2 demo; their architecture (whole-VFS blob snapshot, string boundary) can't do incremental/100MB without a rework — say so with benchmarks, not adjectives. |
| Corpus reveals the subset is too small (agents use arrays/awk heavily) | The corpus decides tier-2 promotion order. If interpreter scope balloons past ~2x estimate, re-open the "embed bashkit, keep our FS" option — decision point at M3 gate. |
| sed/awk are complexity sinks | Timebox; subset by corpus evidence; vendor One True AWK if full awk is demanded. |
| OPFS quirks (Safari handle limits, eviction) | Feature-detect, `navigator.storage.persist()`, document per-backend durability honestly. Memory backend is always the fallback. |
| JS-registered command perf (boundary crossing) | Acceptable for custom commands; hot path (built-ins) never crosses. Document the difference. |
| `Filesystem` API surface creep | Occam clause: data API capped ~10 methods; additions require a written case in a PR. |
| Solo vs funded competitors | Don't out-staff; out-position. FS + format + published numbers is a defensible solo-sized wedge. Re-validate demand at M2 (the refresh-survival demo is the probe). |

## Explicitly deferred decisions

- npm package name / crate names (check availability at M0)
- Full image format spec freeze (v1, after real usage)
- Journal/replay design (slot reserved in format; design doc when we get there)
- Server & multi-language packaging: same C ABI as `cdylib` for Bun/Deno
  FFI, Python, Go; native-only backends (file/mmap, Postgres, S3) ride that
  build (napi-rs consciously rejected — FFI covers more hosts)
- awk strategy (M4 gate, corpus-driven)
- `spawn()` streaming exec shape; `sandbox.tool()` agent-SDK sugar
