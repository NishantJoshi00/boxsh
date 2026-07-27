// StorageBackend proxy over the wasm filesystem: the tree, its semantics,
// and the replication journal all live in Rust (boxsh-fs behind boxsh-abi);
// this file only ferries bytes across the boundary. See boxsh-abi/src/fs.rs
// for the export conventions mirrored here.
import type { BackendEntry, StorageBackend } from "../backend.js";
import { BoxshError, type ErrnoCode } from "../errors.js";
import { compileModule, load, type BoxshInstance, type ModuleSource } from "../loader.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const ENOENT = -1;
const ENOTDIR = -3;
const EISDIR = -4;

const STATUS: Record<number, [ErrnoCode, string]> = {
  [-1]: ["ENOENT", "no such file or directory"],
  [-2]: ["EEXIST", "file exists"],
  [-3]: ["ENOTDIR", "not a directory"],
  [-4]: ["EISDIR", "is a directory"],
  [-5]: ["ENOTEMPTY", "directory not empty"],
  [-6]: ["EINVAL", "invalid argument"],
};

interface FsExports {
  boxsh_fs_new(): number;
  boxsh_fs_drop(handle: number): number;
  boxsh_fs_set_time(handle: number, nowMs: bigint): number;
  boxsh_fs_read(handle: number, path: number, pathLen: number, out: number): number;
  boxsh_fs_write(handle: number, path: number, pathLen: number, data: number, dataLen: number): number;
  boxsh_fs_entry(handle: number, path: number, pathLen: number, out: number): number;
  boxsh_fs_list(handle: number, path: number, pathLen: number, out: number): number;
  boxsh_fs_mkdir(handle: number, path: number, pathLen: number): number;
  boxsh_fs_remove(handle: number, path: number, pathLen: number): number;
  boxsh_fs_rename(handle: number, from: number, fromLen: number, to: number, toLen: number): number;
  boxsh_fs_take_dirty(handle: number, out: number): number;
  boxsh_fs_restore(
    handle: number,
    path: number,
    pathLen: number,
    mtime: bigint,
    isDir: number,
    data: number,
    dataLen: number,
  ): number;
}

/** A StorageBackend whose state lives in a wasm filesystem instance. */
export interface WasmFsBackend extends StorageBackend {
  /** Drain the replication journal (see boxsh-fs DESIGN.md). */
  takeDirty(): string[];
  /** Recreate a node during hydration; `null` data restores a directory. */
  restore(path: string, mtime: number, data: Uint8Array | null): void;
}

export interface WasmMemoryBackendOptions {
  /** Filesystem wasm module; defaults to the one bundled with the package. */
  module?: ModuleSource;
}

/**
 * Non-persistent backend whose state lives in the Rust wasm filesystem —
 * the same filesystem the persistent backends replicate from, minus the
 * persistence. The Rust-side sibling of `memory()`.
 */
export async function wasmMemory(options: WasmMemoryBackendOptions = {}): Promise<StorageBackend> {
  const moduleSource = options.module ?? new URL("../../engine/fs.wasm", import.meta.url);
  return wasmFilesystem(await load(await compileModule(moduleSource)));
}

/** Open a filesystem inside a loaded boxsh module. */
export function wasmFilesystem(instance: BoxshInstance): WasmFsBackend {
  const candidate = instance.exports as Partial<FsExports>;
  if (typeof candidate.boxsh_fs_new !== "function") {
    throw new Error(
      "This boxsh module has no filesystem exports. Update the module (rebuild boxsh-abi) or pass one that matches this package version.",
    );
  }
  const fs = candidate as FsExports;
  const handle = fs.boxsh_fs_new();
  const outCell = instance.alloc(8);
  const entryCell = instance.alloc(24);
  let open = true;

  const view = () => new DataView(instance.memory.buffer);
  const bytes = () => new Uint8Array(instance.memory.buffer);

  const stage = (b: Uint8Array): number => {
    if (b.length === 0) return 0;
    const ptr = instance.alloc(b.length);
    bytes().set(b, ptr);
    return ptr;
  };
  const unstage = (ptr: number, len: number): void => {
    if (len !== 0) instance.free(ptr, len);
  };

  const takeBuffer = (): Uint8Array => {
    const ptr = view().getUint32(outCell, true);
    const len = view().getUint32(outCell + 4, true);
    if (len === 0) return new Uint8Array(0);
    const copy = bytes().slice(ptr, ptr + len);
    instance.free(ptr, len);
    return copy;
  };

  const decodePathList = (b: Uint8Array): string[] => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: string[] = [];
    let at = 0;
    while (at < b.length) {
      const len = v.getUint32(at, true);
      at += 4;
      out.push(dec.decode(b.subarray(at, at + len)));
      at += len;
    }
    return out;
  };

  const fail = (s: number, path: string): never => {
    const mapped = STATUS[s];
    if (mapped) throw new BoxshError(mapped[0], path, `${mapped[0]}: ${mapped[1]}: ${path}`);
    throw new Error(`boxsh filesystem call failed (status ${s})`);
  };

  const withPath = <T>(path: string, f: (ptr: number, len: number) => T): T => {
    const b = enc.encode(path);
    const ptr = stage(b);
    try {
      return f(ptr, b.length);
    } finally {
      unstage(ptr, b.length);
    }
  };

  /** The host owns time: stamp the fs clock before every mutation. */
  const stamp = (): void => {
    fs.boxsh_fs_set_time(handle, BigInt(Date.now()));
  };

  return {
    kind: "wasm",

    read(path) {
      return withPath(path, (p, l) => {
        const s = fs.boxsh_fs_read(handle, p, l, outCell);
        if (s === ENOENT || s === EISDIR) return undefined;
        if (s !== 0) fail(s, path);
        return takeBuffer();
      });
    },

    write(path, data) {
      stamp();
      withPath(path, (p, l) => {
        const d = stage(data);
        try {
          const s = fs.boxsh_fs_write(handle, p, l, d, data.length);
          if (s !== 0) fail(s, path);
        } finally {
          unstage(d, data.length);
        }
      });
    },

    entry(path): BackendEntry | undefined {
      return withPath(path, (p, l) => {
        const s = fs.boxsh_fs_entry(handle, p, l, entryCell);
        if (s !== 0) fail(s, path);
        const v = view();
        const kind = Number(v.getBigUint64(entryCell, true));
        if (kind === 0) return undefined;
        return {
          kind: kind === 2 ? "dir" : "file",
          size: Number(v.getBigUint64(entryCell + 8, true)),
          mtime: Number(v.getBigUint64(entryCell + 16, true)),
        };
      });
    },

    list(path) {
      return withPath(path, (p, l) => {
        const s = fs.boxsh_fs_list(handle, p, l, outCell);
        if (s === ENOENT || s === ENOTDIR) return undefined;
        if (s !== 0) fail(s, path);
        return decodePathList(takeBuffer());
      });
    },

    mkdir(path) {
      stamp();
      withPath(path, (p, l) => {
        const s = fs.boxsh_fs_mkdir(handle, p, l);
        if (s !== 0) fail(s, path);
      });
    },

    remove(path) {
      withPath(path, (p, l) => {
        const s = fs.boxsh_fs_remove(handle, p, l);
        if (s !== 0) fail(s, path);
      });
    },

    rename(from, to) {
      const f = enc.encode(from);
      const t = enc.encode(to);
      const fp = stage(f);
      const tp = stage(t);
      try {
        const s = fs.boxsh_fs_rename(handle, fp, f.length, tp, t.length);
        if (s !== 0) fail(s, s === ENOENT ? from : to);
      } finally {
        unstage(tp, t.length);
        unstage(fp, f.length);
      }
    },

    takeDirty() {
      const s = fs.boxsh_fs_take_dirty(handle, outCell);
      if (s !== 0) fail(s, "");
      return decodePathList(takeBuffer());
    },

    restore(path, mtime, data) {
      withPath(path, (p, l) => {
        const d = data === null ? 0 : stage(data);
        const dl = data === null ? 0 : data.length;
        try {
          const s = fs.boxsh_fs_restore(handle, p, l, BigInt(mtime), data === null ? 1 : 0, d, dl);
          if (s !== 0) fail(s, path);
        } finally {
          if (data !== null) unstage(d, dl);
        }
      });
    },

    async flush() {},

    async close() {
      if (!open) return;
      open = false;
      fs.boxsh_fs_drop(handle);
    },
  };
}
