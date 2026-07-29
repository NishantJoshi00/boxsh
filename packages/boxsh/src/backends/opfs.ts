// OPFS persistence for the wasm filesystem. Same replication design as the
// indexeddb backend — the tree lives in Rust, mutations drain write-behind —
// but the store is the Origin Private File System: a natural tree of real
// files under boxsh-fs/<name>/tree/, inspectable by devtools and other OPFS
// consumers. OPFS cannot store mtimes, so they ride in a meta.json sidecar
// written at the end of each drain; a missing or stale sidecar degrades to
// default mtimes, never a broken tree.
import type { StorageBackend } from "../backend.js";
import { compileModule, load } from "../loader.js";
import type { EngineSource } from "../module-source.js";
import {
  acquireLock,
  replicatedBackend,
  type ReplicationBatchItem,
} from "./replicated.js";
import { wasmFilesystem, type WasmFsBackend } from "./wasmfs.js";

export interface OpfsBackendOptions {
  /** Logical filesystem name; maps to OPFS directory "boxsh-fs/<name>". */
  name: string;
  /** Filesystem wasm module; defaults to the one bundled with the package. */
  module?: EngineSource;
  /** Delay before a background flush after a mutation. Default 100 ms. */
  flushDebounceMs?: number;
  /** Called when a background flush fails; a retry stays scheduled. */
  onFlushError?: (error: unknown) => void;
  /** Cross-tab safety via Web Locks (where available). Default "exclusive". */
  lock?: "exclusive" | "none";
}

const ROOT_DIR = "boxsh-fs";
const LOCK_PREFIX = "boxsh-opfs:";
const FORMAT_VERSION = 1;

interface Meta {
  formatVersion: number;
  mtimes: Record<string, number>;
}

function assertOpfs(): void {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    throw new Error(
      "OPFS is not available in this environment. The opfs backend runs in browsers; use memory() or indexeddb() elsewhere.",
    );
  }
}

const isNotFound = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "NotFoundError";

async function fsRoot(name: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  const base = await opfs.getDirectoryHandle(ROOT_DIR, { create });
  return base.getDirectoryHandle(name, { create });
}

async function readMeta(root: FileSystemDirectoryHandle): Promise<Meta | undefined> {
  try {
    const handle = await root.getFileHandle("meta.json");
    const parsed = JSON.parse(await (await handle.getFile()).text()) as Meta;
    return parsed;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

// TS's dom lib lags the File System spec: directory handles are async
// iterable, and fresh Uint8Arrays are valid write chunks.
interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

async function writeFileHandle(handle: FileSystemFileHandle, data: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  await w.write(data as BufferSource);
  await w.close();
}

async function hydrate(
  root: FileSystemDirectoryHandle,
  inner: WasmFsBackend,
  mtimes: Record<string, number>,
): Promise<void> {
  let tree: FileSystemDirectoryHandle;
  try {
    tree = await root.getDirectoryHandle("tree");
  } catch (err) {
    if (isNotFound(err)) return; // fresh filesystem
    throw err;
  }
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [child, handle] of (dir as IterableDirectoryHandle).entries()) {
      const path = prefix === "" ? child : `${prefix}/${child}`;
      if (handle.kind === "directory") {
        inner.restore(path, mtimes[path] ?? 0, null);
        await walk(handle as FileSystemDirectoryHandle, path);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        inner.restore(path, mtimes[path] ?? file.lastModified, data);
      }
    }
  };
  await walk(tree, "");
}

/**
 * Open a persistent filesystem backed by OPFS. Same durability model as the
 * indexeddb backend: writes are visible immediately, replicate in the
 * background, `flush()` is the durability checkpoint. Unlike IndexedDB, a
 * drain spans several file operations, so interruption mid-drain can leave
 * the stored tree between batches; the next drain converges it.
 */
export async function opfs(options: OpfsBackendOptions): Promise<StorageBackend> {
  assertOpfs();
  const {
    name,
    flushDebounceMs = 100,
    lock = "exclusive",
    onFlushError = (error) =>
      console.error(`boxsh: background flush of filesystem "${name}" failed; retrying.`, error),
  } = options;

  const release = lock === "exclusive" ? await acquireLock(LOCK_PREFIX + name, name) : undefined;

  let root: FileSystemDirectoryHandle;
  let meta: Meta;
  try {
    root = await fsRoot(name, true);
    const existing = await readMeta(root);
    if (existing && existing.formatVersion > FORMAT_VERSION) {
      throw new Error(
        `Filesystem "${name}" was created by a newer boxsh. Update @boxsh/sandbox to open it.`,
      );
    }
    meta = existing ?? { formatVersion: FORMAT_VERSION, mtimes: {} };
  } catch (err) {
    release?.();
    throw err;
  }

  const moduleSource = options.module ?? new URL("../../engine/fs.wasm", import.meta.url);
  const inner = wasmFilesystem(await load(await compileModule(moduleSource)));
  await hydrate(root, inner, meta.mtimes);

  const tree = await root.getDirectoryHandle("tree", { create: true });

  const dirAt = async (path: string, create: boolean): Promise<FileSystemDirectoryHandle> => {
    let dir = tree;
    if (path === "") return dir;
    for (const seg of path.split("/")) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir;
  };

  const applyBatch = async (batch: ReplicationBatchItem[]): Promise<void> => {
    const items = [...batch].sort((a, b) => (a.path < b.path ? -1 : 1));
    // Deletions first, tolerant of already-gone paths (an ancestor's
    // recursive removal may have taken them).
    for (const { path, entry } of items) {
      if (entry) continue;
      const i = path.lastIndexOf("/");
      const [parent, base] = i === -1 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
      try {
        await (await dirAt(parent, false)).removeEntry(base, { recursive: true });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      delete meta.mtimes[path];
    }
    // Upserts in sorted order: parents before children.
    for (const { path, entry, data } of items) {
      if (!entry) continue;
      if (entry.kind === "dir") {
        await dirAt(path, true);
      } else {
        const i = path.lastIndexOf("/");
        const [parent, base] = i === -1 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
        const dir = await dirAt(parent, true);
        let handle: FileSystemFileHandle;
        try {
          handle = await dir.getFileHandle(base, { create: true });
        } catch {
          // A directory occupies this name (kind change): replace it.
          await dir.removeEntry(base, { recursive: true });
          handle = await dir.getFileHandle(base, { create: true });
        }
        await writeFileHandle(handle, data ?? new Uint8Array(0));
      }
      meta.mtimes[path] = entry.mtime;
    }
    // The sidecar commits the batch's mtimes; written last on purpose.
    const metaHandle = await root.getFileHandle("meta.json", { create: true });
    await writeFileHandle(metaHandle, new TextEncoder().encode(JSON.stringify(meta)));
  };

  const { backend } = replicatedBackend({
    kind: "opfs",
    name,
    inner,
    target: { applyBatch, close: async () => {} },
    flushDebounceMs,
    onFlushError,
    release,
  });
  return backend;
}

/** Delete a filesystem's OPFS directory. Close any open backend first. */
export async function destroyOpfsFilesystem(name: string): Promise<void> {
  assertOpfs();
  try {
    const opfs = await navigator.storage.getDirectory();
    const base = await opfs.getDirectoryHandle(ROOT_DIR);
    await base.removeEntry(name, { recursive: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
