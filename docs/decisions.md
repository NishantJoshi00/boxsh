# nobox — decision log

Running record of architectural decisions made after plan.md was drafted.
Where this file and plan.md disagree, this file wins. Newest at the bottom.

## 2026-07-23 — post-review design session

**D1. Name: nobox, everywhere.** npm package `nobox` (name is taken on npm —
scope `@nobox/*` or variant to be decided at M5; kept private until then),
crates `nobox-core` / `nobox-utils` / `nobox-abi` (all free on crates.io,
checked 2026-07-23). No "wfs" in any artifact.

**D2. Process.** Architecture is decided in discussion (user dictates,
decisions recorded here); Claude implements. On-disk format and `Ctx`/stream
shape get dedicated dictation sessions before their code is written.

**D3. Pipeline execution model: internal Rust `async`.** Commands are written
as ordinary straight-line async code; a hand-written deterministic
single-threaded scheduler (~200 lines, `core::future` only, zero deps) plus
bounded pipe buffers give concurrent interleaving on one thread. Write to a
closed pipe returns EPIPE → early exit (`grep | head` short-circuits), the
userspace equivalent of SIGPIPE. The public API and C ABI stay synchronous:
`exec()` runs the scheduler to completion. Rejected: hand-rolled state
machines (unwritable), buffer-everything (kills the perf story, trait change
later would touch every command).

**D4. Target: `wasm32-wasip1`, self-implemented WASI layer.** We implement
the ~40 WASI preview1 syscalls over our own VFS; we are the host. Two doors
into one VFS: native nobox commands call it directly (fused streaming);
ported code runs against the WASI shim unmodified. Evidence (spiked
2026-07-23, scratchpad): uutils `cat`/`echo`/`wc`/`sort` compile untouched;
ported `cat` ran against a hand-written ~150-line WASI shim over a fake
in-memory store and printed content that existed only there; ported `wc -l`
piped under Node WASI returned correct output. On `wasm32-unknown-unknown`
brush-parser is contaminated by wasm-bindgen imports via mandatory deps
(getrandom/cached/uuid — no feature flag removes them); on wasip1 its import
table collapses to 6 plain WASI functions. The WASI pivot fixes porting and
brush packaging with one move.

**D5. Utilities: ported by default, native for the hot path.** Long tail
ports from uutils (MIT, GNU-test-suite-compatible) via the WASI door; only
the streaming-hot commands (grep/cat/head/tail/… — corpus decides the list)
are written natively against D3. Ported commands in pipelines run
stage-at-a-time buffered (WASI reads are blocking); native commands fuse.
Limits of porting: no fork/exec (shell-level interception for `find -exec`,
`xargs`), no threads (`sort` single-threaded).

**D6. Shell: brush-parser + our async evaluator.** Vendor/depend on
brush-parser (MIT, works on wasip1); write the evaluator ourselves on the D3
scheduler. brush-core surprisingly compiles on wasm but drags tokio (189
crates) and a foreign execution model — revisit only if our evaluator runs
long (spike gate stays at M3).

**D7. Backends V1: in-memory, OPFS, IndexedDB.** OPFS is the flagship (only
browser storage with sync byte-range I/O; massive-files requirement).
IndexedDB backend = image resident in linear memory + async write-behind,
workspace bounded by memory — documented honestly as the compatibility
backend. localStorage rejected on facts: absent in Workers, ~5MB, strings
only.

**D8. Paths are bytes** at the core and ABI. The TS API accepts strings and
encodes UTF-8 at the boundary; core never assumes UTF-8, so this is
reversible later.

**D9. Errors: errno.** WASI errno values at the syscall layer; POSIX-style
exit codes and bash-compatible message text at the command surface — models
expect the strings they were trained on.

**D10. Dependencies.** `nobox-core`: zero dependencies, enforced. Elsewhere:
a justified-dependency whitelist (each addition needs a written case, same
rule as a fifth BlockStore method). Current whitelist: `regex`, `memchr`,
`brush-parser`, `uu_*` crates. Dev-only test suites (brush compat corpus,
Oils spec tests) vendor freely — nothing ships.

**D11. Toolchain.** Latest stable Rust, edition 2024, MSRV = latest. No
wasm-pack, no wasm-bindgen — bare `cargo build --target wasm32-wasip1` plus
our hand-written loader (C ABI + WASI imports). Cargo features per command
for size control. wasmtime as dev-time test runner for the wasm side of the
CI matrix (tooling, not a shipped dep).

**D12. Native/FFI future (design constraints only, build deferred).** Same C
ABI compiles to cdylib. In-Rust backends (file/mmap, Postgres, S3) are
selected by URL and ride the cdylib; host-implemented backends register a
function-pointer vtable — the FFI twin of JS imports. Remote backends batch
blocks into segments internally; the 4-method contract is semantic, not wire
granularity. Ported commands on native default to running as wasip1 modules
under an embedded runtime (byte-identical behavior by construction);
final call at native-build time.

**D13. Git (post-V0, de-risked now).** gitoxide through the WASI door;
local ops (status/add/commit/diff/log) need no network. Clone/push = smart
HTTP over host `fetch()`, needs a CORS proxy for github.com (browser
physics). Compile spike (threads off, no-mmap fallback) alongside M4.
Stopgap if it stalls: isomorphic-git against the public FS API.

**D14. Expectations recorded.** (1) Commands must feel like they run on a
real filesystem — satisfied structurally by the WASI layer. (2) Backend must
be extremely fast and support massive files (git-repo scale) — consequences:
page-cache **eviction is now in M1 scope** (wasm32 4GB linear-memory
ceiling; files larger than memory must work via block access), OPFS
write-coalescing designed into M2 (per-block call overhead would eat the
250ms/100MB gate), inode design keeps indirect pointers now / extents
revisited when packfile benchmarks exist.

**D15. Coreutils scope: port everything that ports (spiked 2026-07-23).**
Sweep of all 109 uutils crates (v0.9.0) on wasm32-wasip1:
- **73 utilities compile clean and run** (spot-checked seq/sort/md5sum/factor
  under WASI): arch b2sum base32/64 basename basenc cat cksum comm cp csplit
  cut date dd dir dircolors dirname echo expand factor false fmt fold head
  join link ln ls md5sum mkdir mktemp mv nl nproc numfmt od paste pathchk pr
  printenv printf ptx pwd readlink realpath rm rmdir seq sha*sum shred shuf
  sleep sort split sum tail tee touch tr true truncate tsort uname unexpand
  uniq unlink vdir wc yes.
- **Native reimplementation list** (fail on wasip1 for platform reasons AND
  should express our FS semantics anyway): test/[ (bash builtin), chmod,
  stat, du, df, env, sync, tac, install; expr (blocked by C oniguruma —
  reimplement over `regex`).
- **Excluded as sandbox-meaningless** (no users/terminals/processes/network/
  devices/SELinux): hostname who users pinky uptime tty stty more nohup
  timeout kill nice chroot stdbuf chown chgrp id groups whoami logname
  hostid mkfifo mknod chcon runcon. Corpus evidence can promote any of these
  to faked-native later.
- **Size:** all 73 in one size-optimized module = 7.0MB raw / **2.8MB gzip**
  — nearly the whole 3MB budget alone. Therefore: default feature set =
  tier-1 subset; `full-coreutils` feature = all 73, documented as exceeding
  the default budget. The 3MB gate applies to default features (per plan).

**D17. (2026-07-24, supersedes the block-layer plan) Per-backend native
storage; no universal block format.** User decision: every backend stores
data its own most-efficient way — OPFS maps our files onto real OPFS files
(in-place writes via sync access handles), IndexedDB one record per file
(transactions give atomicity), Postgres a table (ditto). The pluggable
interface moves up from blocks to file operations (read/write/list/rename/
delete/stat). Consequences: M1's superblock/inode/A-B-commit work is cut;
crash consistency is per-backend (native transactions where available);
the current bash + coreutils set is accepted as the shell ("good/high
quality bash" baseline, grown by demand). Product priorities, in order:
(1) OPFS, IndexedDB, Postgres (non-wasm host) backends, (2) more commands,
(3) public TS API. Guiding metrics: ease of use, realness, performance —
anything serving none of the three is cut.

**D16. wasi-libc path-resolution facts (measured 2026-07-24, playground).**
Load-bearing for the real syscall layer (M1/M2):
- wasi-libc normalizes preopen names such that `/` and `.` both collapse —
  with multiple preopens the LAST match wins for every path. Absolute and
  relative paths arrive at the syscall layer byte-identical (leading slash
  stripped, already resolved). A `.`-preopen can NOT carry cwd semantics.
- cwd lives in wasi-libc's userspace emulation inside the module. The
  working pattern: single `/` preopen + the entrypoint seeds cwd via
  `std::env::set_current_dir(PWD)` (chdir validates the dir with a stat
  first). `getcwd`/`pwd`/relative paths/`..` then all behave correctly.
  nobox's real WASI shim must own cwd the same way.
- uucore takes its error-prefix name from process argv[0] — the multicall
  dispatcher must set argv[0] to the command name, not the binary name.
