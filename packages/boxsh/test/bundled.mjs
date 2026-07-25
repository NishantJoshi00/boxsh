// Packaging test: zero-arg loadEngine() finds the bundled engine modules.
// Run after: npm run build:engine (or build-engine.mjs --copy-only)
import assert from "node:assert/strict";
import { Filesystem, Sandbox, memory, loadEngine } from "../dist/index.js";

const engine = await loadEngine();

const fs = await Filesystem.create({ backend: memory() });
await fs.mkdir("/workspace");
await fs.writeFile("/workspace/message.txt", "hello\nfrom boxsh\n");

const sb = new Sandbox({ fs, engine, cwd: "/workspace" });
const r = await sb.exec("cat message.txt | wc -l");
assert.equal(r.stdout.trim(), "2");
assert.equal(r.code, 0);

// optimized module is wired in too (grep is hot-only routed)
const g = await sb.exec("grep from message.txt");
assert.equal(g.stdout, "from boxsh\n");

console.log("bundled OK: zero-arg loadEngine() runs the packaged engine");
