# boxsh benchmarks

Four harnesses, one per runtime. They measure different layers on purpose —
don't compare numbers across harnesses, compare runs of the same harness
over time.

| bench      | measures                                                        | run |
| ---------- | --------------------------------------------------------------- | --- |
| `browser/` | the playground demo runner (cold/hot spawn, throughput) in a real browser, on the un-optimized `target/` artifacts | serve the repo root (`python3 -m http.server`), open `/bench/browser/bench.html` |
| `node/`    | the shipped package: `dist/` + wasm-opt'd `engine/` modules — shell exec spawn, throughput, file ops, and the memory-vs-wasm-fs backend boundary | `node bench/node/run.mjs [--quick]` |
| `bun/`     | the identical suite under Bun (runtime comparison on equal terms) | `bun bench/bun/run.mjs [--quick]` |
| `rust/`    | `boxsh-fs` natively — the upper bound with no wasm boundary and no host storage | `cd bench/rust && cargo run --release` |

Prerequisites for `node/` and `bun/`:

```sh
npm run build --prefix packages/boxsh
npm run build:engine --prefix packages/boxsh
```

Prerequisite for `browser/`: the two demo crates built (see the root
CLAUDE.md build commands). It intentionally loads the pre-`wasm-opt`
artifacts straight from `examples/playground/*/target/`, so its absolute
numbers differ from the packaged engine.

Reading the layers together: `rust/` gives the raw filesystem cost, the
backend micro-op section of `node/`/`bun/` adds the wasm boundary on top,
and the exec sections add shell + command execution. The gap between
adjacent layers is the cost of that layer, which is the number that should
stay honest over time.

The `rust/` crate is standalone (its own `[workspace]`), like the demo
crates: it never joins the root workspace, so CI and the zero-dep
discipline of the library crates stay untouched.
