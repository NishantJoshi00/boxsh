# boxsh-fs design

The boxsh virtual filesystem, in Rust, headed for the single-reactor wasm
sandbox: filesystem + shell + coreutils in one module, hosts talking to it
through a versioned ABI. This crate is the filesystem piece and supersedes the
TypeScript `backends/memory.ts` (which remains until the reactor lands).

## Path-level, deliberately

State is `BTreeMap<path, node>` — the same model the TypeScript layer ships
today — not an inode/block filesystem. The target backends make blocks the
wrong abstraction: tar is a sequential archive, SQL rows keyed by path stay
queryable and debuggable, IndexedDB records keyed by path hydrate in one
`getAll()`. `boxsh-core`'s `BlockStore` stays dormant as a possible future
performance mode; nothing here depends on it.

Paths are backend form: `""` is the root, segments joined by `/`, no leading
slash. `normalize()` mirrors the TypeScript `normalize` exactly.

## Backend matrix

| Backend    | Where it runs        | Shape                                             |
| ---------- | -------------------- | ------------------------------------------------- |
| in-memory  | everywhere           | `MemoryBackend` — the canonical state             |
| IndexedDB  | browser host (JS)    | replication: hydrate + journal drain over the ABI |
| OPFS       | browser host (JS)    | replication, natural file tree or single image    |
| tar file   | everywhere           | `tar::import` at open / `tar::export` at flush    |
| SQL        | native, feature-gate | implements `Backend` directly; never in wasm      |

Two integration shapes: **native** backends implement `Backend` directly;
**replicated** backends mirror `MemoryBackend` through its journal because the
sandbox cannot reach their storage APIs itself (browser storage is host-side
and async — wasm imports cannot await).

Host-specific store crates (SQL clients, `std::fs`) are separate, feature-gated
crates. `boxsh-fs` itself has zero dependencies and must always build unchanged
on `wasm32-wasip1`; per-target feature matrices are expected and fine.

## Replication contract

`MemoryBackend` journals every path a successful mutation touches (rename
journals the old and new key of every node in the moved subtree). The host
drains with `take_dirty()` — sorted, coalesced, parents before children — and
resolves each path against the *current* tree:

- present → upsert `(path, kind, mtime, bytes)`
- absent → delete

Order does not matter for flat stores (IndexedDB, SQL); stores that enforce
tree invariants apply upserts in order and deletes in reverse. Hydration is
`restore()` in sorted path order: parents sort before children, mtimes are
preserved, nothing is journaled. A drain applied atomically (one IndexedDB
transaction, one SQL transaction) yields a crash-consistent snapshot; the
write-behind window is host policy.

`flush()` on `MemoryBackend` is a no-op — durability belongs to whichever
adapter consumes the journal, and the host decides when to drain (debounce,
per-exec, on close).

## Time

The filesystem never reads a clock. Hosts inject time via `set_time(ms)`;
mtimes stamp from the injected value. Wasm builds have no ambient clock, and
determinism under test is worth the explicitness.

## Semantic hardenings vs memory.ts

Pinned by `tests/semantics.rs`; the TypeScript behaviors were latent bugs:

- `rename` into the source's own subtree → `Invalid` (memory.ts corrupted the
  tree); `rename` over an existing target replaces a file or empty directory,
  refuses a non-empty one with `NotEmpty` (memory.ts clobbered blindly);
  `rename(x, x)` is a no-op (memory.ts deleted the node).
- `remove("")` → `Invalid` (memory.ts could delete the root).
- Typed errors everywhere the TS backend collapsed cases into `undefined`;
  hosts map `Error` onto their errno vocabulary (`ErrnoCode` in TS).

## tar

`tar` is a byte-for-byte twin of `tar.ts`: plain ustar, prefix/name split over
100 bytes, second-precision mtimes, type `5` directories, merge-on-import with
implicit parent creation, import stamps mtimes from the backend clock (not the
archive — matches tar.ts). It doubles as the universal migration format
between any two backends.
