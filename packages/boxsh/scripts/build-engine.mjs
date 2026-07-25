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
    manifest: p("../../../examples/playground/hot-demo/Cargo.toml"),
    artifact: p(
      "../../../examples/playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm",
    ),
    out: p("../engine/commands-optimized.wasm"),
  },
];

const copyOnly = process.argv.includes("--copy-only");

// wasm-opt levels chosen by measurement (2026-07-25, Node 22 bench):
// cold: -Oz is size-neutral-perf, -2% gzip; (-O3 on higher opt-levels
// regressed grep 3x — do not "upgrade" without re-benchmarking).
// hot: -O3 on the opt-level-3+simd build: sort -32%, grep -50% vs z.
crates[0].wasmOpt = "-Oz";
crates[1].wasmOpt = "-O3";

const hasWasmOpt = spawnSync("wasm-opt", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasWasmOpt) {
  console.warn("wasm-opt not found (brew install binaryen) — shipping unoptimized modules");
}

mkdirSync(p("../engine"), { recursive: true });
for (const { manifest, artifact, out, wasmOpt } of crates) {
  if (!copyOnly) {
    const r = spawnSync(
      "cargo",
      ["build", "--release", "--target", "wasm32-wasip1", "--manifest-path", manifest],
      { stdio: "inherit" },
    );
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
