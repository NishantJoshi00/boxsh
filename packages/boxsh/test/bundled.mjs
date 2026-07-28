// Packaging test: zero-arg loadEngine() and zero-config wasmMemory() find
// the bundled engine modules (commands + filesystem/shell).
// Run after: npm run build:engine (or build-engine.mjs --copy-only)
import assert from "node:assert/strict";
import { Filesystem, Sandbox, wasmMemory, loadEngine } from "../dist/index.js";

const engine = await loadEngine();

const fs = await Filesystem.create({ backend: await wasmMemory() });
await fs.mkdir("/workspace");
await fs.writeFile("/workspace/message.txt", "hello\nfrom boxsh\n");

const sb = new Sandbox({ fs, engine, cwd: "/workspace" });
const r = await sb.exec("cat message.txt | wc -l");
assert.equal(r.stdout.trim(), "2");
assert.equal(r.code, 0);

// grep runs inside the sandbox module
const g = await sb.exec("grep from message.txt");
assert.equal(g.stdout, "from boxsh\n");

console.log("bundled OK: zero-arg loadEngine() runs the packaged engine");
