// Build the command modules from the workspace and copy them into engine/,
// where the published package (and zero-arg loadEngine) expects them.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const crates = [
  {
    manifest: p("../../../examples/playground/coreutils-demo/Cargo.toml"),
    artifact: p(
      "../../../examples/playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm",
    ),
    out: p("../engine/commands.wasm"),
  },
  {
    manifest: p("../../../crates/boxsh-abi/Cargo.toml"),
    artifact: p("../../../target/wasm32-wasip1/release/boxsh_abi.wasm"),
    out: p("../engine/fs.wasm"),
    // The shipped module needs the shell's command imports; test builds
    // leave the feature off so plain WASI runners can instantiate.
    features: "host-commands",
  },
];

const copyOnly = process.argv.includes("--copy-only");

// wasm-opt levels chosen by measurement (2026-07-25, Node 22 bench):
// cold: -Oz is size-neutral-perf, -2% gzip; (-O3 on higher opt-levels
// regressed grep 3x — do not "upgrade" without re-benchmarking).
crates[0].wasmOpt = "-Oz";
// sandbox module (fs + shell + in-module commands): the hot path runs here
// now, but it's plain Rust on trait calls — -Oz measured fine; re-bench
// before changing.
crates[1].wasmOpt = "-Oz";

const hasWasmOpt = spawnSync("wasm-opt", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasWasmOpt) {
  console.warn("wasm-opt not found (brew install binaryen) — shipping unoptimized modules");
}

mkdirSync(p("../engine"), { recursive: true });
for (const { manifest, artifact, out, wasmOpt, features } of crates) {
  if (!copyOnly) {
    const args = ["build", "--release", "--target", "wasm32-wasip1", "--manifest-path", manifest];
    if (features) args.push("--features", features);
    const r = spawnSync("cargo", args, { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  if (hasWasmOpt) {
    const r = spawnSync("wasm-opt", ["--all-features", wasmOpt, artifact, "-o", out], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    copyFileSync(artifact, out);
  }
  console.log(`engine: ${out}`);
}
