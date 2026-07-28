// Shared bench suite for JS runtimes (node/, bun/ are thin entries over
// this). Unlike bench/browser, which measures the self-contained playground
// runner, this suite measures the SHIPPED package: dist/ + the wasm-opt'd
// modules in packages/boxsh/engine/. Numbers are not comparable 1:1 across
// the two harnesses.
//
// Prereqs: `npm run build --prefix packages/boxsh` and
//          `npm run build:engine --prefix packages/boxsh`.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const pkg = (rel) => pathToFileURL(p(`../../packages/boxsh/${rel}`)).href;

const enc = new TextEncoder();
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const row = (name, result, detail = "") =>
  console.log(`${name.padEnd(34)} ${String(result).padStart(14)}  ${detail}`);

function makeText(mb) {
  const line = "the quick brown fox jumps over 0123456789\n";
  return enc.encode(line.repeat(Math.ceil((mb * 1024 * 1024) / line.length)));
}

export async function runSuite({ quick = false } = {}) {
  const { Filesystem, Sandbox, loadEngine, memory, wasmMemory } = await import(pkg("dist/index.js"));
  const { load } = await import(pkg("dist/loader.js"));
  const { wasmFilesystem } = await import(pkg("dist/backends/wasmfs.js"));

  const runtime =
    typeof Bun !== "undefined"
      ? `bun ${Bun.version}`
      : typeof process !== "undefined"
        ? `node ${process.version}`
        : "unknown js runtime";
  console.log(`boxsh package bench — ${runtime}${quick ? " (quick)" : ""}\n`);

  // --- startup: compile the packaged engine ---
  const coldBytes = readFileSync(p("../../packages/boxsh/engine/commands.wasm"));
  const fsBytes = readFileSync(p("../../packages/boxsh/engine/fs.wasm"));
  let t = performance.now();
  const engine = await loadEngine({ commands: coldBytes });
  row(
    "engine compile",
    `${fmt(performance.now() - t)} ms`,
    `${(coldBytes.length / 1048576).toFixed(1)} MB of modules`,
  );

  // Exec rows run on the Rust filesystem — the blessed path; memory()
  // appears only in the micro-op boundary comparison below.
  const newSandbox = async (backend) => {
    backend ??= await wasmMemory({ module: fsBytes });
    const fs = await Filesystem.create({ backend });
    return { fs, sb: new Sandbox({ fs, engine }) };
  };

  // --- command spawn: hot (reactor call) vs cold (fresh instance) ---
  const { fs, sb } = await newSandbox();
  const spawnHot = quick ? 200 : 1000;
  for (let i = 0; i < 20; i++) await sb.exec("true");
  t = performance.now();
  for (let i = 0; i < spawnHot; i++) await sb.exec("true");
  let dt = performance.now() - t;
  row("hot `true` via exec", `${((dt / spawnHot) * 1000).toFixed(1)} µs/cmd`, `${fmt(1000 / (dt / spawnHot))} commands/s`);

  await fs.writeFile("/seed.txt", "abc\n");
  const spawnCold = quick ? 40 : 200;
  for (let i = 0; i < 5; i++) await sb.exec("tr a-z A-Z < /seed.txt");
  t = performance.now();
  for (let i = 0; i < spawnCold; i++) await sb.exec("tr a-z A-Z < /seed.txt");
  dt = performance.now() - t;
  row("cold `tr` via exec", `${fmt(dt / spawnCold)} ms/cmd`, `${fmt(1000 / (dt / spawnCold))} commands/s`);

  // --- throughput over files (shipped shell: redirects feed stdin) ---
  const MB = quick ? 2 : 10;
  await fs.writeFile("/data.txt", makeText(MB));
  for (const [name, script] of [
    [`wc -l (${MB}MB)`, "wc -l < /data.txt"],
    [`tr a-z A-Z (${MB}MB)`, "tr a-z A-Z < /data.txt > /dev.out"],
    [`sha256sum (${MB}MB)`, "sha256sum < /data.txt"],
  ]) {
    await sb.exec(script);
    t = performance.now();
    const r = await sb.exec(script);
    dt = performance.now() - t;
    row(name, `${fmt(MB / (dt / 1000))} MB/s`, `${fmt(dt)} ms${r.code !== 0 ? ` EXIT ${r.code}` : ""}`);
  }

  const lines = [];
  const nLines = quick ? 20_000 : 100_000;
  for (let i = 0; i < nLines; i++) lines.push(`line-${(i * 7919) % nLines}-${i}`);
  await fs.writeFile("/sort.txt", lines.join("\n") + "\n");
  t = performance.now();
  await sb.exec("sort < /sort.txt > /sorted.txt");
  dt = performance.now() - t;
  row(`sort (${nLines / 1000}k lines)`, `${fmt(nLines / (dt / 1000) / 1000)}k lines/s`, `${fmt(dt)} ms`);

  t = performance.now();
  await sb.exec("seq 1 200000 | tail -5");
  row("seq 1 200000 | tail -5", `${fmt(performance.now() - t)} ms`, "pipeline through the shell");

  // --- file ops through the shell ---
  const FILES = quick ? 60 : 300;
  await sb.exec("mkdir /bench");
  t = performance.now();
  for (let i = 0; i < FILES; i++) await sb.exec(`echo payload-${i} > /bench/f${i}`);
  dt = performance.now() - t;
  row(`file write via echo (${FILES}×)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt((dt / FILES) * 1000)} µs/file`);
  t = performance.now();
  for (let i = 0; i < FILES; i++) await sb.exec(`cat /bench/f${i}`);
  dt = performance.now() - t;
  row(`file read via cat (${FILES}×)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt((dt / FILES) * 1000)} µs/file`);

  const DIR = quick ? 500 : 2000;
  await fs.mkdir("/big");
  for (let i = 0; i < DIR; i++) await fs.writeFile(`/big/e${i}`, new Uint8Array(8));
  t = performance.now();
  await sb.exec("ls /big");
  dt = performance.now() - t;
  t = performance.now();
  await sb.exec("ls -la /big");
  row(`ls (${DIR} entries)`, `${fmt(dt)} ms`, `ls -la: ${fmt(performance.now() - t)} ms`);

  t = performance.now();
  await sb.exec("rm -r /bench");
  dt = performance.now() - t;
  row(`rm -r (${FILES} files)`, `${fmt(dt)} ms`, `${fmt(FILES / (dt / 1000))} unlinks/s`);

  // --- backend boundary: TS map vs wasm filesystem (persistence tax) ---
  console.log("\nbackend micro-ops, µs/op (memory → wasm-fs → ratio):");
  const wasmBackend = wasmFilesystem(await load(fsBytes));
  const iters = quick ? 4000 : 20000;
  const oneK = new Uint8Array(1024).fill(0x61);
  const suites = [
    ["write 1KiB", (b, n) => { for (let i = 0; i < n; i++) b.write(`bench/w${i % 512}.txt`, oneK); }, iters],
    ["read 1KiB", (b, n) => { for (let i = 0; i < n; i++) b.read(`bench/w${i % 512}.txt`); }, iters],
    ["entry", (b, n) => { for (let i = 0; i < n; i++) b.entry(`bench/w${i % 512}.txt`); }, iters],
    ["list 512", (b, n) => { for (let i = 0; i < n; i++) b.list("bench"); }, Math.floor(iters / 16)],
  ];
  const measure = (b, fn, n) => {
    fn(b, Math.min(n, 50));
    const t0 = performance.now();
    fn(b, n);
    return ((performance.now() - t0) * 1000) / n;
  };
  const memB = memory();
  memB.mkdir("bench");
  wasmBackend.mkdir("bench");
  for (const [name, fn, n] of suites) {
    const a = measure(memB, fn, n);
    const b = measure(wasmBackend, fn, n);
    row(name, `${a.toFixed(2)} → ${b.toFixed(2)}`, `${(b / a).toFixed(2)}x`);
  }
  await wasmBackend.close();
  console.log("\ndone");
}
