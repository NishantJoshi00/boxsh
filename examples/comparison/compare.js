// boxsh vs just-bash vs ZenFS — capability-fair comparison matrix.
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

// cell result: {ms, detail} | {text, cls, detail} | {na: reason} | {err}
function renderRow(name, cells) {
  const tr = document.createElement("tr");
  const best = Math.min(...cells.filter((c) => c.ms !== undefined).map((c) => c.ms));
  tr.innerHTML =
    `<td>${name}</td>` +
    cells
      .map((c) => {
        if (c.text !== undefined)
          return `<td><span class="${c.cls ?? "v"}">${c.text}</span>` +
                 (c.detail ? `<br /><span class="d">${c.detail}</span>` : "") + `</td>`;
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
  say("loading boxsh…");
  const buf = await (await fetch("../playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm", { cache: "no-store" })).arrayBuffer();
  const hotBuf = await (await fetch("../playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm", { cache: "no-store" })).arrayBuffer();
  const nb = createRuntime(await WebAssembly.compile(buf), await WebAssembly.compile(hotBuf));

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
    await timed(() => { for (let i = 0; i < 100; i++) nb.run(["true"]); return "100 command runs"; }),
    await jbCell(async () => { for (let i = 0; i < 100; i++) await jb.exec("true"); return "100 command runs"; }),
    { na: NA_SHELL },
  ]);
  await tick();

  // ---- file writes ----
  say("file writes…");
  const N = 200;
  nb.run(["mkdir", "/b"]);
  if (jb) await jb.exec("mkdir -p /b");
  renderRow(`write ${N}×1KB files (one command per file)`, [
    await timed(() => { for (let i = 0; i < N; i++) nb.run(["tee", `/b/f${i}`], kbB); return `${N} tee commands`; }),
    await jbCell(async () => { for (let i = 0; i < N; i++) await jb.exec(`tee /b/f${i}`, { stdin: kb }); return `${N} tee commands`; }),
    await zfsCell(() => { zfs.mkdirSync("/b", { recursive: true }); for (let i = 0; i < N; i++) zfs.writeFileSync(`/b/f${i}`, kbB); return "writeFileSync (library call)"; }),
  ]);
  await tick();

  say("bulk write, single command…");
  nb.run(["mkdir", "/bulk"]);
  if (jb) await jb.exec("mkdir -p /bulk");
  if (zfs) { try { zfs.mkdirSync("/bulk", { recursive: true }); } catch {} }
  const bulkNames = Array.from({ length: N }, (_, i) => `/bulk/g${i}`);
  renderRow(`write ${N}×1KB files (ONE tee command)`, [
    await timed(() => { nb.run(["tee", ...bulkNames], kbB); return "one call, N files"; }),
    await jbCell(async () => { await jb.exec(`tee ${bulkNames.join(" ")}`, { stdin: kb }); return "one exec, N files"; }),
    await zfsCell(() => { for (const n of bulkNames) zfs.writeFileSync(n, kbB); return "writeFileSync loop"; }),
  ]);
  await tick();

  // ---- file reads ----
  say("file reads…");
  renderRow(`read ${N}×1KB files`, [
    await timed(() => { for (let i = 0; i < N; i++) nb.run(["cat", `/b/f${i}`]); return `${N} cat commands`; }),
    await jbCell(async () => { for (let i = 0; i < N; i++) await jb.exec(`cat /b/f${i}`); return `${N} cat commands`; }),
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

  // ---- binary safety: verdicts, not milliseconds ----
  say("binary safety…");
  const bin = new Uint8Array(65536);
  for (let i = 0; i < bin.length; i++) bin[i] = i & 0xff;
  const truthHex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bin))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // best-possible encoding for just-bash's string-only boundary: one code
  // unit per byte (latin-1 mapping). The boundary itself is what's on trial.
  const latin1 = Array.from(bin, (b) => String.fromCharCode(b)).join("");
  const strToBytes = (s) => {
    const a = new Uint8Array(s.length);
    let wide = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) wide = true;
      a[i] = c & 0xff;
    }
    return { a, wide };
  };
  const bytesEq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const OK = (detail) => ({ text: "intact", cls: "v", detail });
  const BAD = (detail) => ({ text: "CORRUPTED", cls: "err", detail });

  {
    const r = nb.run(["sha256sum"], bin);
    const nbCell = dec.decode(r.out).slice(0, 64) === truthHex
      ? OK("hash of output == hash of the actual bytes")
      : BAD("hash mismatch");
    let jbc = { na: NA_JB };
    if (jb) {
      try {
        const r2 = await jb.exec("sha256sum", { stdin: latin1 });
        jbc = r2.stdout.slice(0, 64) === truthHex
          ? OK("string boundary preserved the bytes")
          : BAD("hashed different bytes than it was given");
      } catch (e) { jbc = BAD(String(e).slice(0, 70)); }
    }
    renderRow("binary fidelity: sha256sum of 64KB, all 256 byte values", [nbCell, jbc, { na: NA_SHELL }]);
  }
  await tick();

  {
    nb.run(["tee", "/bin.dat"], bin);
    const back = nb.run(["cat", "/bin.dat"]).out;
    const nbCell = bytesEq(bin, back) ? OK("tee → cat, byte-identical") : BAD("bytes changed in transit");
    let jbc = { na: NA_JB };
    if (jb) {
      try {
        await jb.exec("tee /bin.dat", { stdin: latin1 });
        const r2 = await jb.exec("cat /bin.dat");
        const { a, wide } = strToBytes(r2.stdout);
        jbc = !wide && bytesEq(bin, a)
          ? OK("survived as code units")
          : BAD(`read back ${r2.stdout.length} units for ${bin.length} bytes`);
      } catch (e) { jbc = BAD(String(e).slice(0, 70)); }
    }
    let zc = { na: NA_ZFS };
    if (zfs) {
      try {
        zfs.writeFileSync("/bin.dat", bin);
        zc = bytesEq(bin, new Uint8Array(zfs.readFileSync("/bin.dat"))) ? OK("byte API") : BAD("bytes changed");
      } catch (e) { zc = BAD(String(e).slice(0, 70)); }
    }
    renderRow("binary round-trip: write then read 64KB", [nbCell, jbc, zc]);
  }
  await tick();

  {
    // 1000 known match lines interleaved with binary junk lines
    const parts = [];
    const junk = new Uint8Array(64);
    for (let i = 0; i < 1000; i++) {
      parts.push(enc.encode("the fox jumps\n"));
      crypto.getRandomValues(junk);
      for (let j = 0; j < junk.length; j++) if (junk[j] === 0x0a) junk[j] = 0x0b;
      parts.push(junk.slice());
      parts.push(enc.encode("\n"));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const noisy = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { noisy.set(p, at); at += p.length; }

    const nbN = dec.decode(nb.run(["grep", "-c", "fox"], noisy).out).trim();
    const nbCell = nbN === "1000" ? OK("1000/1000 matches in binary stream") : BAD(`counted ${nbN}, expected 1000`);
    let jbc = { na: NA_JB };
    if (jb) {
      try {
        const r2 = await jb.exec("grep -c fox", { stdin: Array.from(noisy, (b) => String.fromCharCode(b)).join("") });
        const n = r2.stdout.trim();
        jbc = n === "1000" ? OK("1000/1000") : BAD(`counted ${n || "(nothing)"}, expected 1000`);
      } catch (e) { jbc = BAD(String(e).slice(0, 70)); }
    }
    renderRow("grep -c through binary noise (1000 known matches)", [nbCell, jbc, { na: NA_SHELL }]);
  }
  await tick();

  say("grep…");
  renderRow("grep -c 'fox' on 10MB", [
    await timed(() => { const r = nb.run(["grep", "-c", "fox"], text10b); return `${dec.decode(r.out).trim()} matches`; }),
    await jbCell(async () => { const r = await jb.exec("grep -c fox", { stdin: text10 }); return `${r.stdout.trim()} matches`; }),
    { na: NA_SHELL },
  ]);
  await tick();

  say("shell workflows…");
  renderRow("seq 1 200000 | tail -5", [
    await timed(() => { const s = nb.run(["seq", "1", "200000"]); const r = nb.run(["tail", "-5"], s.out); return `ends ${dec.decode(r.out).trim().split("\n").pop()}`; }),
    await jbCell(async () => { const r = await jb.exec("seq 1 200000 | tail -5"); return `ends ${r.stdout.trim().split("\n").pop()}`; }),
    { na: NA_SHELL },
  ]);
  renderRow("for i in $(seq 1 500); do true; done", [
    await timed(() => {
      const words = dec.decode(nb.run(["seq", "1", "500"]).out).trim().split("\n");
      for (const w of words) nb.run(["true"]);
      return "500 iterations";
    }),
    await jbCell(async () => { await jb.exec("for i in $(seq 1 500); do true; done"); return "500 iterations"; }),
    { na: NA_SHELL },
  ]);

  say(`done — ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "?"}`);
  document.getElementById("run").disabled = false;
}

document.getElementById("run").addEventListener("click", () => main().catch((e) => say(`failed: ${e}`)));
main().catch((e) => say(`failed: ${e}`));
