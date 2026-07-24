// nobox bench — self-contained (own minimal WASI runner; playground untouched).
const enc = new TextEncoder();
const dec = new TextDecoder();
const E = { OK: 0, BADF: 8, EXIST: 20, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
class ProcExit { constructor(code) { this.code = code; } }

const store = new Map([["", { dir: true, mtime: Date.now() }]]);
const norm = (p) => {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const childrenOf = (dir) =>
  [...store.keys()].filter(
    (k) => k !== "" && k.startsWith(dir === "" ? "" : dir + "/") &&
      !k.slice(dir === "" ? 0 : dir.length + 1).includes("/"),
  );
const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

let wasmModule = null;

function run(argv, stdinBytes) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const bytes = (p, l) => new Uint8Array(memory.buffer, p, l);
  const args = [argv[0], ...argv];
  const envs = ["PWD=/"];
  const stdin = stdinBytes ?? new Uint8Array(0);
  let stdinPos = 0;
  const stdout = [];
  let nextFd = 5;
  const fds = new Map([[3, { path: "", dir: true, preopen: "/" }]]);
  const res = (_d, raw) => norm(raw);
  const setStrings = (list, aP, bP) => {
    for (const s of list) {
      view().setUint32(aP, bP, true); aP += 4;
      const b = enc.encode(s);
      bytes(bP, b.length).set(b);
      view().setUint8(bP + b.length, 0); bP += b.length + 1;
    }
    return E.OK;
  };
  const fileStat = (buf, entry) => {
    bytes(buf, 64).fill(0);
    view().setUint8(buf + 16, entry.dir ? 3 : 4);
    view().setBigUint64(buf + 24, 1n, true);
    view().setBigUint64(buf + 32, BigInt(entry.data?.length ?? 0), true);
    const t = BigInt(entry.mtime ?? Date.now()) * 1_000_000n;
    view().setBigUint64(buf + 40, t, true);
    view().setBigUint64(buf + 48, t, true);
    view().setBigUint64(buf + 56, t, true);
  };
  const impl = {
    args_sizes_get(cP, sP) { view().setUint32(cP, args.length, true); view().setUint32(sP, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true); return E.OK; },
    args_get: (aP, bP) => setStrings(args, aP, bP),
    environ_sizes_get(cP, sP) { view().setUint32(cP, envs.length, true); view().setUint32(sP, envs.reduce((n, a) => n + a.length + 1, 0), true); return E.OK; },
    environ_get: (aP, bP) => setStrings(envs, aP, bP),
    fd_prestat_get(fd, buf) { if (fd !== 3) return E.BADF; view().setUint8(buf, 0); view().setUint32(buf + 4, 1, true); return E.OK; },
    fd_prestat_dir_name(fd, ptr) { bytes(ptr, 1)[0] = 47; return E.OK; },
    path_create_directory(d, pP, pL) { const p = res(d, dec.decode(bytes(pP, pL))); if (store.has(p)) return E.EXIST; store.set(p, { dir: true, mtime: Date.now() }); return E.OK; },
    path_remove_directory(d, pP, pL) { const p = res(d, dec.decode(bytes(pP, pL))); const e = store.get(p); if (!e) return E.NOENT; if (!e.dir) return E.NOTDIR; if (childrenOf(p).length) return E.NOTEMPTY; store.delete(p); return E.OK; },
    path_open(d, df, pP, pL, oflags, rB, rI, fdflags, outP) {
      const p = res(d, dec.decode(bytes(pP, pL)));
      const CREAT = 1, EXCL = 4, TRUNC = 8;
      let entry = store.get(p);
      if (entry && oflags & CREAT && oflags & EXCL) return E.EXIST;
      if (!entry) {
        if (!(oflags & CREAT)) return E.NOENT;
        entry = { data: new Uint8Array(0), mtime: Date.now() };
        store.set(p, entry);
      } else if (!entry.dir && oflags & TRUNC) { entry.data = new Uint8Array(0); }
      const fd = nextFd++;
      fds.set(fd, entry.dir ? { path: p, dir: true } : { path: p, pos: fdflags & 1 ? entry.data.length : 0 });
      view().setUint32(outP, fd, true);
      return E.OK;
    },
    path_filestat_get(d, fl, pP, pL, buf) { const e = store.get(res(d, dec.decode(bytes(pP, pL)))); if (!e) return E.NOENT; fileStat(buf, e); return E.OK; },
    path_rename(od, oP, oL, nd, nP, nL) {
      const from = res(od, dec.decode(bytes(oP, oL))), to = res(nd, dec.decode(bytes(nP, nL)));
      if (!store.has(from)) return E.NOENT;
      store.set(to, store.get(from)); store.delete(from);
      return E.OK;
    },
    path_unlink_file(d, pP, pL) { const p = res(d, dec.decode(bytes(pP, pL))); const e = store.get(p); if (!e) return E.NOENT; if (e.dir) return E.ISDIR; store.delete(p); return E.OK; },
    fd_fdstat_get(fd, buf) {
      const ftype = fd <= 2 ? 2 : fds.get(fd)?.dir ? 3 : 4;
      bytes(buf, 24).fill(0);
      view().setUint8(buf, ftype);
      view().setBigUint64(buf + 8, 0xffffffffffffffffn, true);
      view().setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E.OK;
    },
    fd_filestat_get(fd, buf) {
      if (fd <= 2) { bytes(buf, 64).fill(0); view().setUint8(buf + 16, 2); return E.OK; }
      const f = fds.get(fd);
      if (!f) return E.BADF;
      fileStat(buf, store.get(f.path) ?? { dir: f.dir });
      return E.OK;
    },
    fd_readdir(fd, buf, bufLen, cookie, usedP) {
      const f = fds.get(fd);
      if (!f?.dir) return E.NOTDIR;
      const names = childrenOf(f.path).map((k) => k.split("/").pop()).sort();
      let used = 0;
      for (let i = Number(cookie); i < names.length; i++) {
        const name = enc.encode(names[i]);
        const need = 24 + name.length;
        if (used + need > bufLen) break;
        const at = buf + used;
        view().setBigUint64(at, BigInt(i + 1), true);
        view().setBigUint64(at + 8, BigInt(i + 100), true);
        view().setUint32(at + 16, name.length, true);
        const full = f.path === "" ? names[i] : `${f.path}/${names[i]}`;
        view().setUint8(at + 20, store.get(full)?.dir ? 3 : 4);
        bytes(at + 24, name.length).set(name);
        used += need;
      }
      view().setUint32(usedP, used, true);
      return E.OK;
    },
    fd_read(fd, iovsP, iovsLen, nP) {
      const f = fd === 0 ? null : fds.get(fd);
      if (fd !== 0 && !f) return E.BADF;
      const data = fd === 0 ? stdin : store.get(f.path)?.data ?? new Uint8Array(0);
      let pos = fd === 0 ? stdinPos : f.pos;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        const n = Math.min(bl, data.length - pos);
        bytes(bp, n).set(data.subarray(pos, pos + n));
        pos += n; total += n;
        if (n < bl) break;
      }
      if (fd === 0) stdinPos = pos; else f.pos = pos;
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_write(fd, iovsP, iovsLen, nP) {
      let total = 0;
      const chunks = [];
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        chunks.push(bytes(bp, bl).slice());
        total += bl;
      }
      if (fd === 1) stdout.push(...chunks);
      else if (fd !== 2) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        const entry = store.get(f.path);
        if (!entry || entry.dir) return E.BADF;
        for (const c of chunks) {
          const grown = new Uint8Array(Math.max(entry.data.length, f.pos + c.length));
          grown.set(entry.data);
          grown.set(c, f.pos);
          entry.data = grown;
          f.pos += c.length;
        }
        entry.mtime = Date.now();
      }
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_seek(fd, off, whence, outP) {
      const f = fds.get(fd);
      if (!f || f.dir) return E.BADF;
      const len = store.get(f.path)?.data?.length ?? 0;
      f.pos = Number((whence === 0 ? 0n : whence === 1 ? BigInt(f.pos) : BigInt(len)) + off);
      view().setBigUint64(outP, BigInt(f.pos), true);
      return E.OK;
    },
    fd_close(fd) { fds.delete(fd); return E.OK; },
    fd_sync: () => E.OK,
    fd_fdstat_set_flags: () => E.OK,
    fd_filestat_set_times: () => E.OK,
    path_filestat_set_times: () => E.OK,
    clock_time_get(id, prec, outP) { view().setBigUint64(outP, BigInt(Date.now()) * 1_000_000n, true); return E.OK; },
    random_get(p, l) { crypto.getRandomValues(bytes(p, l)); return E.OK; },
    sched_yield: () => E.OK,
    proc_exit(code) { throw new ProcExit(code); },
  };
  const imports = new Proxy(impl, { get: (t, n) => t[n] ?? (() => E.NOSYS) });
  const inst = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: imports });
  memory = inst.exports.memory;
  let code = 0;
  try { inst.exports._start(); } catch (e) { if (e instanceof ProcExit) code = e.code; else throw e; }
  return { out: concat(stdout), code };
}

// ---------- benchmarks ----------
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

  say("compiling module…");
  const t0 = performance.now();
  const resp = await fetch("./coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm");
  const buf = await resp.arrayBuffer();
  const t1 = performance.now();
  wasmModule = await WebAssembly.compile(buf);
  const t2 = performance.now();
  row("module compile", `${fmt(t2 - t1)} ms`, `${(buf.byteLength / 1048576).toFixed(1)} MB module, fetch ${fmt(t1 - t0)} ms`);
  await tick();

  say("spawn overhead…");
  for (let i = 0; i < 10; i++) run(["true"]);
  let t = performance.now();
  const SPAWNS = 200;
  for (let i = 0; i < SPAWNS; i++) run(["true"]);
  let dt = performance.now() - t;
  row("command spawn (`true`)", `${fmt(dt / SPAWNS)} ms/cmd`, `${fmt(1000 / (dt / SPAWNS))} commands/s — instantiate + run + exit`);
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
  row(`tr a-z A-Z (${MB}MB)`, `${fmt(MB / (dt / 1000))} MB/s`, `${fmt(dt)} ms, output re-buffered to JS`);
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
  row("seq 1 200000 | tail -5", `${fmt(dt)} ms`, `buffered 2-stage pipeline (fusion lands M4); ends ${dec.decode(tailOut.out).trim().split("\n").pop()}`);
  await tick();

  say("file writes…");
  const FILES = 300;
  const body = makeText(0.001); // ~1KB
  run(["mkdir", "/bench"]);
  t = performance.now();
  for (let i = 0; i < FILES; i++) run(["tee", `/bench/f${i}`], body);
  dt = performance.now() - t;
  row(`file write via tee (${FILES}×1KB)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt(dt / FILES)} ms/file incl. spawn`);
  await tick();

  say("file reads…");
  t = performance.now();
  for (let i = 0; i < FILES; i++) run(["cat", `/bench/f${i}`]);
  dt = performance.now() - t;
  row(`file read via cat (${FILES}×1KB)`, `${fmt(FILES / (dt / 1000))} files/s`, `${fmt(dt / FILES)} ms/file incl. spawn`);
  await tick();

  say("big directory…");
  for (let i = 0; i < 2000; i++) store.set(`big/e${i}`, { data: new Uint8Array(8), mtime: Date.now() });
  store.set("big", { dir: true, mtime: Date.now() });
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
