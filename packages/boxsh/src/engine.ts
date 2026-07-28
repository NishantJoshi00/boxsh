/** Run supported commands against a storage backend. */
import type { StorageBackend } from "./backend.js";
import { normalize } from "./backend.js";
import { BoxshError } from "./errors.js";

const enc = new TextEncoder();

const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 } as const;
const ERRNO: Record<string, number> = {
  ENOENT: E.NOENT, EEXIST: E.EXIST, ENOTDIR: E.NOTDIR, EISDIR: E.ISDIR, ENOTEMPTY: E.NOTEMPTY, EINVAL: E.INVAL,
};

class ProcExit {
  constructor(readonly code: number) {}
}

export interface ExecResult {
  out: Uint8Array;
  err: Uint8Array;
  code: number;
}

export interface EngineModules {
  cold: WebAssembly.Module;
}

/** Commands available through the core command module. */
const COLD_COMMANDS = new Set((
  "arch b2sum base32 base64 basename basenc cat cksum comm cp csplit cut date dd dir dircolors dirname echo " +
  "expand factor false fmt fold grep head join link ln ls md5sum mkdir mktemp mv nl nproc numfmt od paste " +
  "pathchk pr printenv printf ptx pwd readlink realpath rm rmdir seq sha1sum sha224sum sha256sum sha384sum " +
  "sha512sum shred shuf sleep sort split sum tail tee touch tr true truncate tsort uname unexpand uniq unlink " +
  "vdir wc yes"
).split(" "));

interface OpenFile {
  path: string;
  dir?: true;
  /** working copy; committed to the backend on close if dirty */
  buf?: Uint8Array;
  pos: number;
  dirty: boolean;
}

interface Ctx {
  stdin: Uint8Array;
  stdinPos: number;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  nextFd: number;
  fds: Map<number, OpenFile>;
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

export interface Engine {
  run(argv: string[], stdin: Uint8Array, env: Record<string, string>, cwd: string): ExecResult;
  knows(command: string): boolean;
}

/**
 * Executor for the uutils multicall module: a fresh instance per command,
 * WASI shims mapped onto the virtual filesystem. The frequently used
 * commands never reach this — they run inside the sandbox module itself
 * (boxsh-commands); this is the long tail.
 */
export function createEngine(
  modules: EngineModules,
  backendRef: { current: StorageBackend },
): Engine {
  const dec = new TextDecoder();
  let ctx: Ctx = null as unknown as Ctx;
  let mem: WebAssembly.Memory = null as unknown as WebAssembly.Memory;
  let args: string[] = [];
  let liveEnv: Record<string, string> = {};
  let liveCwd = "/";

  const freshCtx = (stdin?: Uint8Array): Ctx => ({
    stdin: stdin ?? new Uint8Array(0),
    stdinPos: 0,
    stdout: [],
    stderr: [],
    nextFd: 5,
    fds: new Map([[3, { path: "", dir: true as const, pos: 0, dirty: false }]]),
  });

  const view = () => new DataView(mem.buffer);
  const bytes = (p: number, l: number) => new Uint8Array(mem.buffer, p, l);
  const backend = () => backendRef.current;

  /** Run a backend op, mapping typed errors to WASI errnos. */
  const sys = (fn: () => number): number => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof BoxshError) return ERRNO[e.code] ?? E.INVAL;
      throw e;
    }
  };

  const envPairs = () => {
    const all = { ...liveEnv, PWD: liveCwd };
    return Object.entries(all).map(([k, v]) => `${k}=${v}`);
  };

  const setStrings = (list: string[], aP: number, bP: number): number => {
    for (const s of list) {
      view().setUint32(aP, bP, true);
      aP += 4;
      const b = enc.encode(s);
      bytes(bP, b.length).set(b);
      view().setUint8(bP + b.length, 0);
      bP += b.length + 1;
    }
    return E.OK;
  };

  const statInto = (buf: number, kind: "file" | "dir", size: number, mtime: number): void => {
    bytes(buf, 64).fill(0);
    view().setUint8(buf + 16, kind === "dir" ? 3 : 4);
    view().setBigUint64(buf + 24, 1n, true);
    view().setBigUint64(buf + 32, BigInt(size), true);
    const t = BigInt(mtime) * 1_000_000n;
    view().setBigUint64(buf + 40, t, true);
    view().setBigUint64(buf + 48, t, true);
    view().setBigUint64(buf + 56, t, true);
  };

  const readPath = (pP: number, pL: number): string => normalize(dec.decode(bytes(pP, pL)));

  const impl: Record<string, (...a: never[]) => number> = {
    args_sizes_get(cP: number, sP: number) {
      view().setUint32(cP, args.length, true);
      view().setUint32(sP, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return E.OK;
    },
    args_get: (aP: number, bP: number) => setStrings(args, aP, bP),
    environ_sizes_get(cP: number, sP: number) {
      const pairs = envPairs();
      view().setUint32(cP, pairs.length, true);
      view().setUint32(sP, pairs.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return E.OK;
    },
    environ_get: (aP: number, bP: number) => setStrings(envPairs(), aP, bP),
    fd_prestat_get(fd: number, buf: number) {
      if (fd !== 3) return E.BADF;
      view().setUint8(buf, 0);
      view().setUint32(buf + 4, 1, true);
      return E.OK;
    },
    fd_prestat_dir_name(fd: number, ptr: number) {
      bytes(ptr, 1)[0] = 47;
      return E.OK;
    },
    path_create_directory: (d: number, pP: number, pL: number) =>
      sys(() => {
        backend().mkdir(readPath(pP, pL));
        return E.OK;
      }),
    path_remove_directory: (d: number, pP: number, pL: number) =>
      sys(() => {
        const p = readPath(pP, pL);
        const e = backend().entry(p);
        if (!e) return E.NOENT;
        if (e.kind !== "dir") return E.NOTDIR;
        backend().remove(p);
        return E.OK;
      }),
    path_open(d: number, df: number, pP: number, pL: number, oflags: number, rB: bigint, rI: bigint, fdflags: number, outP: number) {
      return sys(() => {
        const p = readPath(pP, pL);
        const CREAT = 1, EXCL = 4, TRUNC = 8;
        const APPEND = 1;
        const meta = backend().entry(p);
        if (meta && oflags & CREAT && oflags & EXCL) return E.EXIST;
        let file: OpenFile;
        if (meta?.kind === "dir") {
          file = { path: p, dir: true, pos: 0, dirty: false };
        } else if (!meta) {
          if (!(oflags & CREAT)) return E.NOENT;
          // create eagerly so the file exists even if never written
          backend().write(p, new Uint8Array(0));
          file = { path: p, buf: new Uint8Array(0), pos: 0, dirty: false };
        } else {
          const data = oflags & TRUNC ? new Uint8Array(0) : (backend().read(p) ?? new Uint8Array(0)).slice();
          file = { path: p, buf: data, pos: fdflags & APPEND ? data.length : 0, dirty: (oflags & TRUNC) !== 0 };
        }
        const fd = ctx.nextFd++;
        ctx.fds.set(fd, file);
        view().setUint32(outP, fd, true);
        return E.OK;
      });
    },
    path_filestat_get: (d: number, fl: number, pP: number, pL: number, buf: number) =>
      sys(() => {
        const e = backend().entry(readPath(pP, pL));
        if (!e) return E.NOENT;
        statInto(buf, e.kind, e.size, e.mtime);
        return E.OK;
      }),
    path_rename: (od: number, oP: number, oL: number, nd: number, nP: number, nL: number) =>
      sys(() => {
        backend().rename(readPath(oP, oL), readPath(nP, nL));
        return E.OK;
      }),
    path_unlink_file: (d: number, pP: number, pL: number) =>
      sys(() => {
        const p = readPath(pP, pL);
        const e = backend().entry(p);
        if (!e) return E.NOENT;
        if (e.kind === "dir") return E.ISDIR;
        backend().remove(p);
        return E.OK;
      }),
    fd_fdstat_get(fd: number, buf: number) {
      const ftype = fd <= 2 ? 2 : ctx.fds.get(fd)?.dir ? 3 : 4;
      bytes(buf, 24).fill(0);
      view().setUint8(buf, ftype);
      view().setBigUint64(buf + 8, 0xffffffffffffffffn, true);
      view().setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E.OK;
    },
    fd_filestat_get(fd: number, buf: number) {
      if (fd <= 2) {
        bytes(buf, 64).fill(0);
        view().setUint8(buf + 16, 2);
        return E.OK;
      }
      const f = ctx.fds.get(fd);
      if (!f) return E.BADF;
      if (f.dir) {
        const e = backend().entry(f.path);
        statInto(buf, "dir", 0, e?.mtime ?? Date.now());
      } else {
        statInto(buf, "file", f.buf?.length ?? 0, Date.now());
      }
      return E.OK;
    },
    fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, usedP: number) {
      const f = ctx.fds.get(fd);
      if (!f?.dir) return E.NOTDIR;
      const names = (backend().list(f.path) ?? []).sort();
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
        view().setUint8(at + 20, backend().entry(full)?.kind === "dir" ? 3 : 4);
        bytes(at + 24, name.length).set(name);
        used += need;
      }
      view().setUint32(usedP, used, true);
      return E.OK;
    },
    fd_read(fd: number, iovsP: number, iovsLen: number, nP: number) {
      const f = fd === 0 ? null : ctx.fds.get(fd);
      if (fd !== 0 && !f) return E.BADF;
      const data = fd === 0 ? ctx.stdin : (f as OpenFile).buf ?? new Uint8Array(0);
      let pos = fd === 0 ? ctx.stdinPos : (f as OpenFile).pos;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        const n = Math.min(bl, data.length - pos);
        bytes(bp, n).set(data.subarray(pos, pos + n));
        pos += n;
        total += n;
        if (n < bl) break;
      }
      if (fd === 0) ctx.stdinPos = pos;
      else (f as OpenFile).pos = pos;
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_write(fd: number, iovsP: number, iovsLen: number, nP: number) {
      let total = 0;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        chunks.push(bytes(bp, bl).slice());
        total += bl;
      }
      if (fd === 1) ctx.stdout.push(...chunks);
      else if (fd === 2) ctx.stderr.push(...chunks);
      else {
        const f = ctx.fds.get(fd);
        if (!f || f.dir) return E.BADF;
        for (const c of chunks) {
          const need = f.pos + c.length;
          if (!f.buf || need > f.buf.length) {
            const grown = new Uint8Array(Math.max(need, f.buf?.length ?? 0));
            if (f.buf) grown.set(f.buf);
            f.buf = grown;
          }
          f.buf.set(c, f.pos);
          f.pos += c.length;
        }
        f.dirty = true;
      }
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_seek(fd: number, off: bigint, whence: number, outP: number) {
      const f = ctx.fds.get(fd);
      if (!f || f.dir) return E.BADF;
      const len = f.buf?.length ?? 0;
      const base = whence === 0 ? 0n : whence === 1 ? BigInt(f.pos) : BigInt(len);
      f.pos = Number(base + off);
      view().setBigUint64(outP, BigInt(f.pos), true);
      return E.OK;
    },
    fd_close(fd: number) {
      const f = ctx.fds.get(fd);
      if (f && !f.dir && f.dirty && f.buf) {
        try {
          backendRef.current.write(f.path, f.buf);
        } catch {
          return E.INVAL;
        }
      }
      ctx.fds.delete(fd);
      return E.OK;
    },
    fd_sync: () => E.OK,
    fd_fdstat_set_flags: () => E.OK,
    fd_filestat_set_times: () => E.OK,
    path_filestat_set_times: () => E.OK,
    clock_time_get(id: number, prec: bigint, outP: number) {
      view().setBigUint64(outP, BigInt(Date.now()) * 1_000_000n, true);
      return E.OK;
    },
    random_get(p: number, l: number) {
      crypto.getRandomValues(bytes(p, l));
      return E.OK;
    },
    sched_yield: () => E.OK,
    proc_exit(code: number): never {
      throw new ProcExit(code);
    },
  };

  const imports = {
    wasi_snapshot_preview1: new Proxy(impl, {
      get: (t, n) => (t as Record<string | symbol, unknown>)[n] ?? (() => E.NOSYS),
    }),
  } as WebAssembly.Imports;

  return {
    run(argv, stdin, env, cwd) {
      liveEnv = env;
      liveCwd = cwd;
      ctx = freshCtx(stdin);
      args = [argv[0], ...argv];
      const inst = new WebAssembly.Instance(modules.cold, imports);
      mem = inst.exports.memory as WebAssembly.Memory;
      let code = 0;
      try {
        (inst.exports._start as () => void)();
      } catch (e) {
        if (e instanceof ProcExit) code = e.code;
        else throw e;
      }
      return { out: concat(ctx.stdout), err: concat(ctx.stderr), code };
    },
    knows: (command) => COLD_COMMANDS.has(command),
  };
}
