// M0 smoke test: the real wasm artifact loads through the real loader.
// Run after: cargo build --release --target wasm32-wasip1 -p nobox-abi
//        and: npm run build
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { load, SUPPORTED_ABI_VERSION } from "../dist/loader.js";

const wasmPath = fileURLToPath(
  new URL("../../../target/wasm32-wasip1/release/nobox_abi.wasm", import.meta.url),
);

const nobox = await load(readFileSync(wasmPath));
assert.equal(nobox.abiVersion, SUPPORTED_ABI_VERSION);

// alloc gives us writable linear memory; free doesn't trap.
const ptr = nobox.alloc(4096);
assert.notEqual(ptr, 0);
new Uint8Array(nobox.memory.buffer, ptr, 4096).fill(0x5a);
nobox.free(ptr, 4096);

console.log(`smoke OK: abi v${nobox.abiVersion}, alloc/free round-trip at ptr=${ptr}`);
