# nobox Context — companion to plan.md

Everything a fresh agent needs that is NOT in the plan: why decisions were
made, what the competition looks like in detail, where this is headed, and
which assumptions are unproven. Read plan.md first; this second.

## Product thesis and evolution ladder

**The sandbox is a file.** The long-term IP is the portable image format:
one image contains the whole sandbox (FS, workspace, env, later a journal).
Every future feature is a property of that format:

- **V0 (now):** browser, WASM, memory+OPFS, two-object TS API. Prove speed +
  persistence.
- **v1:** ingress/egress — tar/zip/folder import, tar export. Already useful.
- **v2:** portability — snapshot → single image file; share it; mount someone
  else's; diff two snapshots (= audit what an agent did).
- **v3:** continuity — native build (same crates, C-ABI cdylib) mounts the
  same image server-side; browser⇄cloud migration = upload image + resume.
  `switchBackend` to a remote store is secretly this primitive.
- **Beyond:** journaled replay = Temporal-style resumable agent execution
  (event-source the steps into the image, replay on resume). The browser tab
  is a bad durability substrate; the image outlives it. On servers the same
  model gets real durability. This is why determinism (invariant 1) and the
  reserved journal slot (invariant 3) exist.

**Why client-side execution at all** (vs e2b/Modal/Cloudflare server
sandboxes): NOT cost per hour — at ~$0.05/vCPU-hr cost is not the buyer's
pain. The real wedges: 0ms cold start (vs 90–150ms), data residency (code
never leaves the device), offline, zero marginal cost across N users. The
same WASM artifact also embeds server-side (Node/Bun/Deno/edge) — that is
where the proven demand is today (just-bash's ~913k weekly downloads are
almost entirely server-side sandboxing of LLM tool calls).

## Agent workload profile (what actually matters)

From a working agent's (Claude's) own tool-usage distribution — this drives
tier-1 priorities:
1. ~80% of operations: boring file I/O — read, write, string-replace edit,
   list, stat. If the VFS is fast and atomic, most value is delivered.
2. Next: search — grep (ripgrep-class speed changes agent behavior) and
   glob/find. Treat as first-class, worth SIMD investment.
3. Shell usage is a narrow, disciplined subset: pipes, redirects, &&/||,
   command substitution, heredocs, sed/awk/sort/uniq/wc/head/tail/xargs/diff.
   Agents essentially never need job control, interactivity, or terminal
   control. Behavioral drift (quoting, exit codes, word splitting) is what
   kills fake shells, not missing exotic features.
4. Most-wanted beyond coreutils: **git** (status/diff/log/commit) — tier-2,
   categorically raises usefulness. Interpreters (python/node) are
   project-dependent: mountable later, never baked in.
5. Agents emit full bash command STRINGS — the shell-string interface is the
   compatibility target, which is why a shell exists at all (utilities-as-API
   alone would force every harness to translate).

## Competitive dossier (researched 2026-07-23, source-verified)

**bashkit** (everruns; Rust; MIT; ~207★; 1,593 commits; created 2026-01):
the architectural twin. 164 commands natively reimplemented, no fork/exec,
async tokio core; napi native build + separate WASM build
(`@everruns/bashkit-wasm`, ~88 dl/wk — near-zero browser adoption).
Deliberately single-threaded, no SharedArrayBuffer/COOP/COEP (we copied this
constraint — it is correct). Vendor benchmarks (native, in-process, NOT
wasm): ~25x geo-mean faster than just-bash, 0.457ms avg/case. Weaknesses,
verified in source: NO persistence (only whole-VFS opaque-blob snapshot —
unusable at 100MB), string-only JS boundary (`readFile(path): string`, no
Uint8Array), it is side-infrastructure for their agent-harness startup, not
the product. **Race condition: if bashkit ships OPFS, our wedge narrows.
Their naive version would be weeks of work; naive-but-shipped beats
principled-but-absent in perception. Speed to M2 matters.**

**just-bash** (Vercel Labs; TypeScript; ~4k★; ~913k npm dl/wk, compounding):
distribution leader, technical laggard. In maintenance mode (2–6 commits/wk
vs bashkit's 13–159) with 82 open issues. Browser entry point broken
(statically imports node:zlib; other open issues). Zero OPFS/IndexedDB code;
an OPFS feature request has sat unanswered since 2026-02. Known bug classes
— use these as regression tests AND marketing: grep multiple `-e` patterns
not OR-combined; jq array-deletion idioms silently no-op; cat/jq/cut corrupt
multibyte UTF-8 through pipes/redirects; 0.5MB files fail (spread-operator
scaling); chmod metadata not honored. Maintains an "AI Agent Priority List"
roadmap doc worth reading. **License anomaly: README/npm say Apache-2.0 but
the repo has NO LICENSE file — never copy code from just-bash.**

**Turso AgentFS**: POSIX-style agent FS, SQLite-over-OPFS, snapshot/audit,
funded team, IDENTICAL thesis about agents needing CLI tools. The other half
of nobox done well. **coplane/localsandbox** (~154★) already glues
just-bash + AgentFS + Pyodide — on Deno, not browser, "not security
audited". The shell×FS convergence is underway; window is months, not years.

**brush** (Rust bash, ~2.1k★, MIT, ~1,700-test compat suite): looks like a
shortcut, IS NOT. Its wasm32 support is a facade — `sys/wasm/mod.rs`
re-exports stubs for every subsystem; pipes read 0 bytes; no VFS; fs defers
to std::fs (no-op on wasm32-unknown-unknown). **Do not build on brush.
DO vendor its parser design ideas and its MIT test corpus.**

**uutils coreutils** (23.8k★, MIT, Rust): ideal code source for utilities;
already runs 60+ utils in a browser playground — but targets
`wasm32-wasip1`, not `wasm32-unknown-unknown`, and explicitly refuses to be
a shell. Borrow implementations where the license and target allow.

**Not competition:** nushell-wasm (fs/IO disabled, stale, not bash), 
rusty_bash (27/84 own-measure compat, no wasm), CodeSandbox Nodebox (dead
since 2023, Sustainable Use License), AgentVM (Node-only, experimental),
WebVM/CheerpX (x86 emulation, proprietary commercial license — different
product), container2wasm (too slow), server sandboxes (e2b ~$0.05/vCPU-hr
~150ms cold start; Daytona; Modal; Cloudflare Sandboxes; Fly — all
server-only). **Amla Sandbox**: WASI, Rust, but AGPL-3.0/BUSL-1.1 — its
license backlash is evidence permissive licensing is a real wedge.

**Category landscape:** ~9 just-bash clones exist, ALL in-memory. GitHub
search shell+opfs = zero repos. Nobody has persistence. Everyone rebuilt
the shell; nobody built the filesystem. That asymmetry is the whole bet.

## Decision log (with the why)

1. **Build our own interpreter rather than embed bashkit** — despite bashkit
   being MIT and 164 commands ahead. Why: WASM-first optimization (their
   WASM is an afterthought), one-memory-boundary + C-ABI invariants
   (their string boundary violates it), and the FS integration is our core.
   PRE-COMMITTED ESCAPE HATCH: if interpreter effort balloons past ~2x the
   M3 estimate, re-open "embed bashkit, keep our FS" at the M3 gate.
2. **bash is a command, not a layer** — same fn(ctx)->i32 interface as ls.
   Unix-shaped; nested bash/sh scripts fall out free. Honest note: this
   relocates parser work, does not remove it (~2-3wk stands).
3. **Plug at the block layer, not the FS layer** (ZenFS's mistake) — backends
   are 4-method block stores; semantics/journaling/atomicity implemented
   once above. Any KV/DB/object store qualifies (postgres = one table).
4. **Two-object API** (Filesystem + Sandbox) — user initially wanted one rich
   Filesystem object; conceded Sandbox when session state (env/cwd
   persisting across exec calls) needed a home. Sandbox is disposable, fs is
   not; two sandboxes may share one fs.
5. **C-ABI/FFI boundary, napi-rs rejected** — FFI covers Bun/Deno/Python/Go
   with one contract; WASM is just the first host. No wasm-bindgen: its glue
   hides copies and is JS-only.
6. **One memory boundary** — JS heap never owns data. OPFS sync handles
   read/write DIRECTLY into wasm linear memory via per-call ephemeral views
   (held views die on memory.grow). Copies only at explicit egress.
7. **Dual-target always green** — every command tests on wasm32 AND native
   every commit. Wasm backends: fast+reliable browser stores. Native
   backends (later): file/mmap, Postgres, S3 — bigger arsenal. Behavior
   identical to the byte.
8. **Corpus-as-spec** — compat target is the empirical distribution of
   agent-emitted commands, not POSIX. Differential-test against real bash;
   publish the number. Oracle suites: brush (MIT, vendor), Oils spec tests
   (Apache-2.0, vendor subset), GNU bash tests (GPL — run-only in CI, never
   vendor).
9. **FS before shell** (M1/M2 before M3/M4) — the FS is the differentiator;
   the shell is the demo. Also the earliest demand probe (M2 refresh demo).
10. **Occam's razor is the tiebreaker** — stated user principle. Cap API
    surfaces; every concept fights for existence; minimal first.

## Unvalidated assumptions (be honest with yourself)

- **Demand for browser-side persistence is UNPROVEN.** Validation steps were
  designed (trace just-bash browser usage, count persistence-request
  engagement, interview 5 builders) but the user chose to build first. The
  M2 refresh-survival demo doubles as the demand probe. Evidence FOR: e2b
  sells server-side snapshot/persistence; bolt.new proved browser execution
  at scale. Evidence AGAINST: bashkit-wasm 88 dl/wk; just-bash browser
  issues draw little engagement.
- bashkit's 25x benchmark is vendor-run, native-only. Independent WASM
  benches (ours, published, reproducible) are both a validation and a
  marketing asset — nobody in the field publishes browser numbers.
- No project in this space has verified production deployments; adoption
  signals are registry-level. The category is ~7 months old.

## Practical notes

- Repo state: zero commits as of 2026-07-23. plan.md + context.md should be
  the first commit.
- `.claude/settings.json` exists with `worktree.bgIsolation: "none"` —
  added so a background agent could write to this then-commitless repo.
  Remove if unwanted once history exists.
- A memory file exists at the Claude project-memory path
  (wfs-competitive-landscape.md) summarizing the research; the dossier above
  supersedes it in detail.
- Name availability (npm "nobox", crate names) unchecked — do at M0.
- Corpus seed: the user's own Claude Code transcripts (~/.claude/projects/)
  — scrub before publishing anything derived from them.
