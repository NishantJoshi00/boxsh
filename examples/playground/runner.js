// nobox runner — minimal WASI shim + in-page store, shared by bench.js and
// ../comparison/. (shell.js keeps its own copy with terminal integration.)
const enc = new TextEncoder();
const dec = new TextDecoder();
const E = { OK: 0, BADF: 8, EXIST: 20, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
class ProcExit { constructor(code) { this.code = code; } }


const norm = (p) => {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

export function createRuntime(wasmModule) {
const store = new Map([["", { dir: true, mtime: Date.now() }]]);
const childrenOf = (dir) =>
  [...store.keys()].filter(
    (k) => k !== "" && k.startsWith(dir === "" ? "" : dir + "/") &&
      !k.slice(dir === "" ? 0 : dir.length + 1).includes("/"),
  );
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


  const seedFile = (p, data) => store.set(p, { data, mtime: Date.now() });
  const seedDir = (p) => store.set(p, { dir: true, mtime: Date.now() });
  return { run, store, seedFile, seedDir, enc, dec };
}
