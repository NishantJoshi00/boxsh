// IndexedDB backend: hydrate/drain replication against the real wasm
// filesystem (state in Rust), through a real IndexedDB implementation.
// Run after: cargo build --release --target wasm32-wasip1 -p boxsh-abi
//        and: npm run build
import "fake-indexeddb/auto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  Filesystem,
  Sandbox,
  loadEngine,
  memory,
  indexeddb,
  destroyIndexedDBFilesystem,
  BoxshError,
} from "../dist/index.js";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const fsModule = await WebAssembly.compile(
  readFileSync(p("../../../target/wasm32-wasip1/release/boxsh_abi.wasm")),
);
const open = (name, opts = {}) => indexeddb({ name, module: fsModule, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- persistence round trip: write, close, reopen, verify ---
{
  const b = await open("roundtrip");
  const fs = await Filesystem.create({ backend: b });
  await fs.mkdir("/src/deep", { recursive: true });
  await fs.writeFile("/src/hello.txt", "hello boxsh\n");
  const bin = new Uint8Array(8192).map((_, i) => (i * 31 + 7) & 0xff);
  await fs.writeFile("/src/deep/blob.bin", bin);
  const before = await fs.stat("/src/hello.txt");
  await b.close();

  const b2 = await open("roundtrip");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.readFile("/src/hello.txt", "utf-8"), "hello boxsh\n");
  assert.deepEqual(await fs2.readFile("/src/deep/blob.bin"), bin);
  const after = await fs2.stat("/src/hello.txt");
  assert.equal(after.mtime, before.mtime, "mtimes survive persistence");
  assert.deepEqual(
    (await fs2.readdir("/src")).map((e) => `${e.name}:${e.kind}`),
    ["deep:dir", "hello.txt:file"],
  );
  // Typed errors surface from the wasm filesystem.
  await assert.rejects(
    () => fs2.readFile("/missing"),
    (e) => e instanceof BoxshError && e.code === "ENOENT",
  );
  await b2.close();
  console.log("idb: round trip OK");
}

// --- mutations after reopen: rename subtree, delete, kind change ---
{
  const b = await open("mutate");
  const fs = await Filesystem.create({ backend: b });
  await fs.mkdir("/a/nested", { recursive: true });
  await fs.writeFile("/a/f.txt", "f");
  await fs.writeFile("/a/nested/g.txt", "g");
  await fs.writeFile("/doomed.txt", "x");
  await b.flush();

  await fs.rename("/a", "/b");
  await fs.rm("/doomed.txt");
  await fs.rm("/b/f.txt");
  await fs.mkdir("/b/f.txt"); // same path, now a directory
  await b.close();

  const b2 = await open("mutate");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.exists("/a"), false);
  assert.equal(await fs2.readFile("/b/nested/g.txt", "utf-8"), "g");
  assert.equal(await fs2.exists("/doomed.txt"), false);
  assert.equal((await fs2.stat("/b/f.txt")).kind, "dir", "kind change persisted");
  await b2.close();
  console.log("idb: rename/delete/kind-change OK");
}

// --- background write-behind drains without an explicit flush ---
{
  const b = await open("behind", { flushDebounceMs: 20 });
  const fs = await Filesystem.create({ backend: b });
  await fs.writeFile("/auto.txt", "drained");
  await sleep(200); // no flush(), no close(): simulate an abandoned tab
  const b2 = await open("behind");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.readFile("/auto.txt", "utf-8"), "drained");
  await b2.close();
  await b.close();
  console.log("idb: background drain OK");
}

// --- sandbox end to end: commands write through to IndexedDB ---
// Needs the demo command crates; skipped when they are not built (CI's
// wasm job builds only boxsh-abi).
const commandsPath = p(
  "../../../examples/playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm",
);
if (!existsSync(commandsPath)) {
  console.log("idb: sandbox end-to-end SKIPPED (command modules not built)");
} else {
  const engine = await loadEngine({
    commands: readFileSync(commandsPath),
    optimizedCommands: readFileSync(
      p("../../../examples/playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm"),
    ),
  });
  const b = await open("sandbox");
  const fs = await Filesystem.create({ backend: b });
  const sb = new Sandbox({ fs, engine });
  let r = await sb.exec("mkdir -p /work && echo persisted via shell > /work/out.txt");
  assert.equal(r.code, 0, r.stderr);
  r = await sb.exec("cat /work/out.txt");
  assert.equal(r.stdout, "persisted via shell\n");
  await b.close();

  const b2 = await open("sandbox");
  const fs2 = await Filesystem.create({ backend: b2 });
  const sb2 = new Sandbox({ fs: fs2, engine });
  r = await sb2.exec("cat /work/out.txt");
  assert.equal(r.stdout, "persisted via shell\n", "shell-written file survived reopen");
  await b2.close();
  console.log("idb: sandbox end-to-end OK");
}

// --- Rust-initiated persistence push: shell writes drain without flush ---
// The shell and in-module commands mutate the filesystem inside wasm,
// bypassing the backend wrapper entirely; the module's host_fs_dirty
// signal must still get those writes scheduled for replication.
if (existsSync(commandsPath)) {
  const engine = await loadEngine({ commands: readFileSync(commandsPath) });
  const b = await open("push", { flushDebounceMs: 20 });
  const fs = await Filesystem.create({ backend: b });
  const sb = new Sandbox({ fs, engine });
  await sb.exec("echo pushed > /via-shell.txt && seq 1 3 | tee /via-tee.txt");
  await sleep(250); // no flush(), no close(): the push must have scheduled the drain
  const b2 = await open("push");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.readFile("/via-shell.txt", "utf-8"), "pushed\n");
  assert.equal(await fs2.readFile("/via-tee.txt", "utf-8"), "1\n2\n3\n");
  await b2.close();
  await b.close();
  console.log("idb: dirty-push persistence OK");
}

// --- migration: memory -> indexeddb -> memory via switchBackend ---
{
  const fs = await Filesystem.create({ backend: memory() });
  await fs.mkdir("/keep");
  await fs.writeFile("/keep/data.txt", "migrated");
  await fs.switchBackend(await open("migrate"));

  const b2 = await open("migrate");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.readFile("/keep/data.txt", "utf-8"), "migrated");
  await fs2.switchBackend(memory());
  assert.equal(await fs2.readFile("/keep/data.txt", "utf-8"), "migrated");
  console.log("idb: switchBackend migration OK");
}

// --- destroy removes the database ---
{
  const b = await open("gone");
  const fs = await Filesystem.create({ backend: b });
  await fs.writeFile("/f", "x");
  await b.close();
  await destroyIndexedDBFilesystem("gone");
  const b2 = await open("gone");
  const fs2 = await Filesystem.create({ backend: b2 });
  assert.equal(await fs2.exists("/f"), false, "destroyed filesystem is empty");
  await b2.close();
  console.log("idb: destroy OK");
}

// --- closed backends refuse work ---
{
  const b = await open("closed");
  await b.close();
  assert.throws(() => b.write("f", new Uint8Array(1)), /closed/);
  await b.close(); // idempotent
  console.log("idb: closed-backend guard OK");
}

// --- format version guard ---
{
  await new Promise((resolve, reject) => {
    const req = indexedDB.open("boxsh-fs:future", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("entries", { keyPath: "path" });
      req.result.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "format", version: 99 });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  await assert.rejects(() => open("future"), /newer boxsh/);
  console.log("idb: format version guard OK");
}

console.log("idb tests OK");
