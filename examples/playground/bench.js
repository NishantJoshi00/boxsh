// boxsh bench — table harness; engine lives in runner.js.
import { createRuntime } from "./runner.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
let rt = null;
const run = (argv, stdin) => rt.run(argv, stdin);

const rows = document.getElementById("rows");
const status = document.getElementById("status");
const say = (t) => (status.textContent = t);
const row = (name, result, detail) => {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${name}</td><td class="num">${result}</td><td>${detail}</td>`;
  rows.appendChild(tr);
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const fmt = (n) => n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);

function makeText(mb) {
  const line = "the quick brown fox jumps over 0123456789\n";
  const reps = Math.ceil((mb * 1024 * 1024) / line.length);
  return enc.encode(line.repeat(reps));
}

async function bench() {
  document.getElementById("run").disabled = true;
  rows.innerHTML = "";

  say("starting benchmark…");
  const t0 = performance.now();
  const resp = await fetch("./coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm", { cache: "no-store" });
  const buf = await resp.arrayBuffer();
  const hotBuf = await (await fetch("./hot-demo/target/wasm32-wasip1/release/hot_demo.wasm", { cache: "no-store" })).arrayBuffer();
  const t1 = performance.now();
  rt = createRuntime(await WebAssembly.compile(buf), await WebAssembly.compile(hotBuf));
  const t2 = performance.now();
  row(
    "startup",
    `${fmt(t2 - t1)} ms`,
    `${((buf.byteLength + hotBuf.byteLength) / 1048576).toFixed(1)} MB downloaded in ${fmt(t1 - t0)} ms`,
  );
  await tick();

  say("standard command startup…");
  for (let i = 0; i < 10; i++) rt.runCold(["true"]);
  let t = performance.now();
  const SPAWNS = 200;
  for (let i = 0; i < SPAWNS; i++) rt.runCold(["true"]);
  let dt = performance.now() - t;
  row("standard `true` command", `${fmt(dt / SPAWNS)} ms/cmd`, `${fmt(1000 / (dt / SPAWNS))} commands/s`);
  await tick();

  say("optimized command startup…");
  for (let i = 0; i < 10; i++) run(["true"]);
  t = performance.now();
  const CALLS = 1000;
  for (let i = 0; i < CALLS; i++) run(["true"]);
  dt = performance.now() - t;
  row("optimized `true` command", `${(dt / CALLS * 1000).toFixed(1)} µs/cmd`, `${fmt(1000 / (dt / CALLS))} commands/s`);
  await tick();

  const MB = 10;
  const text = makeText(MB);
  say(`wc -l on ${MB}MB…`);
  run(["wc", "-l"], text);
  t = performance.now();
  const wcOut = run(["wc", "-l"], text);
  dt = performance.now() - t;
  row(`wc -l (${MB}MB stdin)`, `${fmt(MB / (dt / 1000))} MB/s`, `${fmt(dt)} ms, ${dec.decode(wcOut.out).trim()} lines`);
  await tick();

  say(`tr on ${MB}MB…`);
  t = performance.now();
  run(["tr", "a-z", "A-Z"], text);
  dt = performance.now() - t;
  row(`tr a-z A-Z (${MB}MB)`, `${fmt(MB / (dt / 1000))} MB/s`, `${fmt(dt)} ms, ${MB}MB output`);
  await tick();

  say(`sha256sum on ${MB}MB…`);
  t = performance.now();
  run(["sha256sum"], text);
  dt = performance.now() - t;
  row(`sha256sum (${MB}MB)`, `${fmt(MB / (dt / 1000))} MB/s`, `${fmt(dt)} ms`);
  await tick();

  say("sort 100k lines…");
  const lines = [];
  for (let i = 0; i < 100_000; i++) lines.push(`line-${(i * 7919) % 100000}-${i}`);
  const sortIn = enc.encode(lines.join("\n") + "\n");
  t = performance.now();
  run(["sort"], sortIn);
  dt = performance.now() - t;
  row("sort (100k lines)", `${fmt(100000 / (dt / 1000) / 1000)}k lines/s`, `${fmt(dt)} ms`);
  await tick();

  say("pipeline seq | tail…");
  t = performance.now();
  const seqOut = run(["seq", "1", "200000"]);
  const tailOut = run(["tail", "-5"], seqOut.out);
  dt = performance.now() - t;
  row("seq 1 200000 | tail -5", `${fmt(dt)} ms`, `ends ${dec.decode(tailOut.out).trim().split("\n").pop()}`);
  await tick();

  say("file writes…");
  const FILES = 300;
  const body = makeText(0.001); // ~1KB
  run(["mkdir", "/bench"]);
  t = performance.now();
  for (let i = 0; i < FILES; i++) run(["tee", `/bench/f${i}`], body);
  dt = performance.now() - t;
  row(`file write via tee (${FILES}×1KB)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt(dt / FILES)} ms/file`);
  await tick();

  say("file reads…");
  t = performance.now();
  for (let i = 0; i < FILES; i++) run(["cat", `/bench/f${i}`]);
  dt = performance.now() - t;
  row(`file read via cat (${FILES}×1KB)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt(dt / FILES)} ms/file`);
  await tick();

  say("big directory…");
  rt.seedDir("big");
  for (let i = 0; i < 2000; i++) rt.seedFile(`big/e${i}`, new Uint8Array(8));
  t = performance.now();
  run(["ls", "/big"]);
  dt = performance.now() - t;
  const tLa = performance.now();
  run(["ls", "-la", "/big"]);
  const dtLa = performance.now() - tLa;
  row("ls (2000 entries)", `${fmt(dt)} ms`, `ls -la: ${fmt(dtLa)} ms (stats every entry)`);
  await tick();

  say("cleanup…");
  t = performance.now();
  run(["rm", "-r", "/bench"]);
  dt = performance.now() - t;
  row(`rm -r (${FILES} files)`, `${fmt(dt)} ms`, `${fmt(FILES / (dt / 1000))} unlinks/s`);

  say(`done — ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "unknown browser"}`);
  document.getElementById("run").disabled = false;
}

document.getElementById("run").addEventListener("click", () => bench().catch((e) => say(`failed: ${e}`)));
bench().catch((e) => say(`failed: ${e}`));
