// prepack gate: refuse to pack a tarball without valid engine modules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

for (const rel of ["../engine/commands.wasm", "../engine/fs.wasm"]) {
  let bytes;
  try {
    bytes = readFileSync(p(rel));
  } catch {
    console.error(`missing ${rel} — run \`npm run build:engine\` before packing`);
    process.exit(1);
  }
  if (!WASM_MAGIC.every((b, i) => bytes[i] === b)) {
    console.error(`${rel} is not a wasm module — rebuild with \`npm run build:engine\``);
    process.exit(1);
  }
}
console.log("engine modules present and valid");
