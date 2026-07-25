// M0 smoke test: the real wasm artifact loads through the real loader.
// Run after: cargo build --release --target wasm32-wasip1 -p boxsh-abi
//        and: npm run build
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { load, SUPPORTED_ABI_VERSION } from "../dist/loader.js";

const wasmPath = fileURLToPath(
  new URL("../../../target/wasm32-wasip1/release/boxsh_abi.wasm", import.meta.url),
);

const boxsh = await load(readFileSync(wasmPath));
assert.equal(boxsh.abiVersion, SUPPORTED_ABI_VERSION);

// alloc gives us writable linear memory; free doesn't trap.
const ptr = boxsh.alloc(4096);
assert.notEqual(ptr, 0);
new Uint8Array(boxsh.memory.buffer, ptr, 4096).fill(0x5a);
boxsh.free(ptr, 4096);

console.log(`smoke OK: abi v${boxsh.abiVersion}, alloc/free round-trip at ptr=${ptr}`);
