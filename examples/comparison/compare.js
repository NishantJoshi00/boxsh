// nobox vs just-bash vs ZenFS — capability-fair comparison matrix.
// Each cell: {ms} or "-" (capability gap) or "err". Details under each value.
import { createRuntime } from "../playground/runner.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const rows = document.getElementById("rows");
const status = document.getElementById("status");
const say = (t) => (status.textContent = t);
const tick = () => new Promise((r) => setTimeout(r, 0));
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

function makeText(mb) {
  const line = "the quick brown fox jumps over 0123456789\n";
  return line.repeat(Math.ceil((mb * 1024 * 1024) / line.length));
}

// cell result: {ms, detail} | {na: reason} | {err}
function renderRow(name, cells) {
  const tr = document.createElement("tr");
  const best = Math.min(...cells.filter((c) => c.ms !== undefined).map((c) => c.ms));
  tr.innerHTML =
    `<td>${name}</td>` +
    cells
      .map((c) => {
        if (c.ms !== undefined)
          return `<td><span class="v ${c.ms === best ? "best" : ""}">${fmt(c.ms)} ms</span>` +
                 (c.detail ? `<br /><span class="d">${c.detail}</span>` : "") + `</td>`;
        if (c.na) return `<td><span class="na">–</span><br /><span class="d">${c.na}</span></td>`;
        return `<td><span class="err">err</span><br /><span class="d">${c.err}</span></td>`;
      })
      .join("");
  rows.appendChild(tr);
}

async function timed(fn) {
  try {
    const t = performance.now();
    const detail = await fn();
    return { ms: performance.now() - t, detail: detail ?? "" };
  } catch (e) {
    return { err: String(e).slice(0, 80) };
  }
}

async function main() {
  document.getElementById("run").disabled = true;
  rows.innerHTML = "";

  // ---- load all three tools ----
  say("loading nobox wasm…");
  const buf = await (await fetch("../playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm")).arrayBuffer();
  const nb = createRuntime(await WebAssembly.compile(buf));

  say("loading just-bash from esm.sh…");
  let jb = null, jbErr = "";
  try {
    const mod = await import("https://esm.sh/just-bash@3.1.0");
    jb = new mod.Bash();
  } catch (e) { jbErr = String(e).slice(0, 80); }

  say("loading @zenfs/core…");
  let zfs = null, zfsErr = "";
  // zenfs v2's struct introspection ("Unable to resolve size of class")
  // breaks under every CDN re-bundler tried (esm.sh, jsdelivr, minified or
  // not). v1.11 predates that machinery and loads fine; same fs API surface.
  for (const url of [
    "https://esm.sh/@zenfs/core@1.11.4",
    "https://esm.sh/@zenfs/core@2.5.8?dev",
    "https://cdn.jsdelivr.net/npm/@zenfs/core@2.5.8/+esm",
  ]) {
    try {
      const mod = await import(url);
      mod.fs.writeFileSync("/__probe", "x"); // fail here, not mid-benchmark
      zfs = mod.fs;
      break;
    } catch (e) { zfsErr = String(e).slice(0, 80); }
  }

  const NA_SHELL = "no shell / commands";
  const NA_JB = jb ? null : `load failed: ${jbErr}`;
  const NA_ZFS = zfs ? null : `load failed: ${zfsErr}`;
  const jbCell = (fn, detail) => (jb ? timed(fn) : Promise.resolve({ na: NA_JB }));
  const zfsCell = (fn) => (zfs ? timed(fn) : Promise.resolve({ na: NA_ZFS }));

  const text10 = makeText(10);
  const text10b = enc.encode(text10);
  const sortLines = [];
  for (let i = 0; i < 100_000; i++) sortLines.push(`line-${(i * 7919) % 100000}-${i}`);
  const sortIn = sortLines.join("\n") + "\n";
  const sortInB = enc.encode(sortIn);
  const kb = makeText(0.001);
  const kbB = enc.encode(kb);

  // ---- spawn / exec overhead ----
  say("exec overhead…");
  for (let i = 0; i < 5; i++) nb.run(["true"]);
  if (jb) await jb.exec("true");
  renderRow("run `true` ×100 (exec overhead)", [
    await timed(() => { for (let i = 0; i < 100; i++) nb.run(["true"]); return "wasm instance per command"; }),
    await jbCell(async () => { for (let i = 0; i < 100; i++) await jb.exec("true"); return "interpreter exec() per command"; }),
    { na: NA_SHELL },
  ]);
  await tick();

  // ---- file writes ----
  say("file writes…");
  const N = 200;
  nb.run(["mkdir", "/b"]);
  if (jb) await jb.exec("mkdir -p /b");
  renderRow(`write ${N}×1KB files`, [
    await timed(() => { for (let i = 0; i < N; i++) nb.run(["tee", `/b/f${i}`], kbB); return "tee, incl. spawn"; }),
    await jbCell(async () => { for (let i = 0; i < N; i++) await jb.exec(`tee /b/f${i}`, { stdin: kb }); return "tee, incl. exec"; }),
    await zfsCell(() => { zfs.mkdirSync("/b", { recursive: true }); for (let i = 0; i < N; i++) zfs.writeFileSync(`/b/f${i}`, kbB); return "writeFileSync (library call)"; }),
  ]);
  await tick();

  // ---- file reads ----
  say("file reads…");
  renderRow(`read ${N}×1KB files`, [
    await timed(() => { for (let i = 0; i < N; i++) nb.run(["cat", `/b/f${i}`]); return "cat, incl. spawn"; }),
    await jbCell(async () => { for (let i = 0; i < N; i++) await jb.exec(`cat /b/f${i}`); return "cat, incl. exec"; }),
    await zfsCell(() => { for (let i = 0; i < N; i++) zfs.readFileSync(`/b/f${i}`); return "readFileSync"; }),
  ]);
  await tick();

  // ---- directory listing ----
  say("directory listing…");
  const DIRN = 1000;
  nb.seedDir("big");
  for (let i = 0; i < DIRN; i++) nb.seedFile(`big/e${i}`, new Uint8Array(8));
  if (jb) {
    await jb.exec("mkdir -p /big");
    const names = Array.from({ length: DIRN }, (_, i) => `/big/e${i}`);
    for (let at = 0; at < names.length; at += 250) await jb.exec(`touch ${names.slice(at, at + 250).join(" ")}`);
  }
  if (zfs) {
    zfs.mkdirSync("/big", { recursive: true });
    for (let i = 0; i < DIRN; i++) zfs.writeFileSync(`/big/e${i}`, new Uint8Array(8));
  }
  renderRow(`ls of ${DIRN}-entry dir`, [
    await timed(() => { nb.run(["ls", "/big"]); }),
    await jbCell(async () => { await jb.exec("ls /big"); }),
    await zfsCell(() => { zfs.readdirSync("/big"); return "readdirSync"; }),
  ]);
  renderRow(`stat-heavy list (ls -la, ${DIRN} entries)`, [
    await timed(() => { nb.run(["ls", "-la", "/big"]); }),
    await jbCell(async () => { await jb.exec("ls -la /big"); }),
    await zfsCell(() => { for (const n of zfs.readdirSync("/big")) zfs.statSync(`/big/${n}`); return "readdir + statSync each"; }),
  ]);
  await tick();

  // ---- delete ----
  say("delete…");
  renderRow(`delete ${N} files`, [
    await timed(() => { nb.run(["rm", "-r", "/b"]); return "rm -r"; }),
    await jbCell(async () => { await jb.exec("rm -r /b"); return "rm -r"; }),
    await zfsCell(() => { for (let i = 0; i < N; i++) zfs.unlinkSync(`/b/f${i}`); zfs.rmdirSync("/b"); return "unlinkSync each"; }),
  ]);
  await tick();

  // ---- text throughput (shell tools) ----
  say("wc -l on 10MB…");
  renderRow("wc -l on 10MB", [
    await timed(() => { const r = nb.run(["wc", "-l"], text10b); return `${dec.decode(r.out).trim()} lines`; }),
    await jbCell(async () => { const r = await jb.exec("wc -l", { stdin: text10 }); return `${r.stdout.trim()} lines`; }),
    { na: NA_SHELL },
  ]);
  await tick();

  say("sort 100k lines…");
  renderRow("sort 100k lines", [
    await timed(() => { nb.run(["sort"], sortInB); }),
    await jbCell(async () => { await jb.exec("sort", { stdin: sortIn }); }),
    { na: NA_SHELL },
  ]);
  await tick();

  say("sha256sum 10MB…");
  renderRow("sha256sum on 10MB", [
    await timed(() => { nb.run(["sha256sum"], text10b); }),
    await jbCell(async () => { await jb.exec("sha256sum", { stdin: text10 }); }),
    { na: NA_SHELL },
  ]);
  await tick();

  // ---- their strengths: nobox is honest about its gaps ----
  say("grep (their strength)…");
  renderRow("grep -c 'fox' on 10MB", [
    { na: "grep lands M4 (native)" },
    await jbCell(async () => { const r = await jb.exec("grep -c fox", { stdin: text10 }); return `${r.stdout.trim()} matches`; }),
    { na: NA_SHELL },
  ]);
  await tick();

  say("pipeline + loop grammar…");
  renderRow("seq 1 200000 | tail -5", [
    await timed(() => { const s = nb.run(["seq", "1", "200000"]); nb.run(["tail", "-5"], s.out); return "buffered 2-stage (fusion M4)"; }),
    await jbCell(async () => { await jb.exec("seq 1 200000 | tail -5"); return "native pipeline"; }),
    { na: NA_SHELL },
  ]);
  renderRow("bash loop: for i in $(seq 1 500)", [
    { na: "bash grammar lands M3" },
    await jbCell(async () => { await jb.exec("for i in $(seq 1 500); do true; done"); return "full grammar today"; }),
    { na: NA_SHELL },
  ]);

  say(`done — ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "?"}`);
  document.getElementById("run").disabled = false;
}

document.getElementById("run").addEventListener("click", () => main().catch((e) => say(`failed: ${e}`)));
main().catch((e) => say(`failed: ${e}`));
