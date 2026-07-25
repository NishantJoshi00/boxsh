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

mkdirSync(p("../engine"), { recursive: true });
for (const { manifest, artifact, out } of crates) {
  if (!copyOnly) {
    const r = spawnSync(
      "cargo",
      ["build", "--release", "--target", "wasm32-wasip1", "--manifest-path", manifest],
      { stdio: "inherit" },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  copyFileSync(artifact, out);
  console.log(`engine: ${out}`);
}
