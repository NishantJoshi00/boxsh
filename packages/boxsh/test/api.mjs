// Public API test: Filesystem + Sandbox against the real wasm engine.
// Run after: cargo build --release --target wasm32-wasip1 (both demo crates)
//        and: cargo build --release --target wasm32-wasip1 -p boxsh-abi --features host-commands
//        and: npm run build
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Filesystem, Sandbox, memory, wasmMemory, loadEngine, BoxshError } from "../dist/index.js";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const engine = await loadEngine({
  commands: readFileSync(p("../../../examples/playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm")),
  optimizedCommands: readFileSync(p("../../../examples/playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm")),
});
const fsModule = readFileSync(p("../../../target/wasm32-wasip1/release/boxsh_abi.wasm"));

// --- Filesystem basics (on the Rust filesystem) ---
const fs = await Filesystem.create({ backend: await wasmMemory({ module: fsModule }) });
await fs.mkdir("/src/deep", { recursive: true });
await fs.writeFile("/src/hello.txt", "hello boxsh\n");
assert.equal(await fs.readFile("/src/hello.txt", "utf-8"), "hello boxsh\n");
const entries = await fs.readdir("/src");
assert.deepEqual(entries.map((e) => `${e.name}:${e.kind}`), ["deep:dir", "hello.txt:file"]);
assert.equal((await fs.stat("/src/hello.txt")).size, 12);
await fs.rename("/src/hello.txt", "/src/renamed.txt");
assert.equal(await fs.exists("/src/hello.txt"), false);

// typed errors
await assert.rejects(() => fs.readFile("/missing"), (e) => e instanceof BoxshError && e.code === "ENOENT");

// binary safety through the public API
const bin = new Uint8Array(4096).map((_, i) => i & 0xff);
await fs.writeFile("/src/blob.bin", bin);
assert.deepEqual(await fs.readFile("/src/blob.bin"), bin);

// --- Sandbox ---
const sb = new Sandbox({ fs, engine });
let r = await sb.exec("echo hello from $USER");
assert.equal(r.stdout, "hello from agent\n");
assert.equal(r.code, 0);

// state persists across exec calls
await sb.exec("export GREETING=hey && cd /src");
assert.equal(sb.cwd, "/src");
r = await sb.exec("echo $GREETING $(pwd)");
assert.equal(r.stdout.trim(), "hey /src");

// pipelines + redirects + relative paths against the shared fs
await sb.exec("seq 1 100 | tail -3 | sort -r > top.txt");
assert.equal(await fs.readFile("/src/top.txt", "utf-8"), "99\n98\n100\n");

// heredoc in a multi-line script
r = await sb.exec('cat <<EOF > note.txt\nline one\nline two\nEOF\nwc -l < note.txt');
assert.equal(r.stdout.trim(), "2");

// cold (uutils ls) piped into hot (wc) against the same store
r = await sb.exec("ls /src | wc -l");
assert.equal(r.stdout.trim(), "5"); // deep, renamed.txt, blob.bin, top.txt, note.txt

// command not found is a code, not a crash
r = await sb.exec("definitely-not-a-command");
assert.equal(r.code, 127);
assert.match(r.stderr, /command not found/);

// grep (hot, native) through the API
r = await sb.exec("grep -c boxsh /src/renamed.txt");
assert.equal(r.stdout.trim(), "1");

// two sandboxes share one filesystem
const sb2 = new Sandbox({ fs, engine });
r = await sb2.exec("cat /src/renamed.txt");
assert.equal(r.stdout, "hello boxsh\n");

// --- tar round-trip + switchBackend ---
const tar = await fs.export();
const fs2 = await Filesystem.create({ backend: memory() });
await fs2.import(tar);
assert.equal(await fs2.readFile("/src/renamed.txt", "utf-8"), "hello boxsh\n");
assert.deepEqual(await fs2.readFile("/src/blob.bin"), bin);

// switchBackend to the TS map: Filesystem keeps working; the Sandbox
// refuses with an actionable error (the shell lives in the wasm module).
await fs.switchBackend(memory());
assert.equal(await fs.readFile("/src/renamed.txt", "utf-8"), "hello boxsh\n");
await assert.rejects(() => sb.exec("cat /src/renamed.txt"), /wasm backend/);
// And back: the sandbox follows the switch.
await fs.switchBackend(await wasmMemory({ module: fsModule }));
r = await sb.exec("cat /src/renamed.txt");
assert.equal(r.stdout, "hello boxsh\n");

console.log("api OK: filesystem, sandbox, heredocs, pipes, tar, switchBackend");
