// IndexedDB persistence for the wasm filesystem. The tree lives in Rust;
// this adapter replicates it: hydrate on open (restore, in key order —
// parents before children), then write-behind drains of the Rust journal,
// one IndexedDB transaction per drain so the stored tree is always a
// consistent snapshot. See boxsh-fs DESIGN.md for the replication contract.
import type { StorageBackend } from "../backend.js";
import { compileModule, load, type ModuleSource } from "../loader.js";
import {
  acquireLock,
  replicatedBackend,
  type ReplicationBatchItem,
} from "./replicated.js";
import { wasmFilesystem } from "./wasmfs.js";

export interface IndexedDBBackendOptions {
  /** Logical filesystem name; maps to database "boxsh-fs:<name>". */
  name: string;
  /** Filesystem wasm module; defaults to the one bundled with the package. */
  module?: ModuleSource;
  /** Delay before a background flush after a mutation. Default 100 ms. */
  flushDebounceMs?: number;
  /**
   * Called when a background flush fails. A retry stays scheduled either
   * way, and `flush()` remains the durability checkpoint that surfaces
   * errors to await. Defaults to logging via console.error.
   */
  onFlushError?: (error: unknown) => void;
  /** Cross-tab safety via Web Locks (where available). Default "exclusive". */
  lock?: "exclusive" | "none";
}

const DB_PREFIX = "boxsh-fs:";
const FORMAT_VERSION = 1;

interface EntryRecord {
  path: string;
  kind: "file" | "dir";
  mtime: number;
  data?: Uint8Array;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function assertIndexedDB(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "IndexedDB is not available in this environment. The indexeddb backend runs in browsers (or tests with an IndexedDB implementation installed); use memory() elsewhere.",
    );
  }
}

async function openDatabase(name: string): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_PREFIX + name, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore("entries", { keyPath: "path" });
    req.result.createObjectStore("meta", { keyPath: "key" });
  };
  const db = await request(req);

  const format = (await request(db.transaction("meta").objectStore("meta").get("format"))) as
    | { key: string; version: number }
    | undefined;
  if (format === undefined) {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: "format", version: FORMAT_VERSION });
    await done(tx);
  } else if (format.version > FORMAT_VERSION) {
    db.close();
    throw new Error(
      `Filesystem "${name}" was created by a newer boxsh. Update @boxsh/sandbox to open it.`,
    );
  }
  return db;
}

/**
 * Open a persistent filesystem backed by IndexedDB. The working tree lives
 * in the wasm filesystem; mutations replicate to the database in the
 * background (write-behind). `flush()` is the durability checkpoint;
 * `close()` flushes, releases the tab lock, and frees the wasm state.
 */
export async function indexeddb(options: IndexedDBBackendOptions): Promise<StorageBackend> {
  assertIndexedDB();
  const {
    name,
    flushDebounceMs = 100,
    lock = "exclusive",
    onFlushError = (error) =>
      console.error(`boxsh: background flush of filesystem "${name}" failed; retrying.`, error),
  } = options;

  const release = lock === "exclusive" ? await acquireLock(DB_PREFIX + name, name) : undefined;
  let db: IDBDatabase;
  try {
    db = await openDatabase(name);
  } catch (err) {
    release?.();
    throw err;
  }

  const moduleSource = options.module ?? new URL("../../engine/fs.wasm", import.meta.url);
  const inner = wasmFilesystem(await load(await compileModule(moduleSource)));

  // Hydrate. getAll returns records in key order, so parents precede children.
  const records = (await request(
    db.transaction("entries").objectStore("entries").getAll(),
  )) as EntryRecord[];
  for (const rec of records) {
    inner.restore(rec.path, rec.mtime, rec.kind === "dir" ? null : (rec.data ?? new Uint8Array(0)));
  }

  const applyBatch = (batch: ReplicationBatchItem[]): Promise<void> => {
    const tx = db.transaction("entries", "readwrite");
    const store = tx.objectStore("entries");
    for (const { path, entry, data } of batch) {
      if (!entry) {
        store.delete(path);
      } else {
        const record: EntryRecord = { path, kind: entry.kind, mtime: entry.mtime };
        if (entry.kind === "file") record.data = data ?? new Uint8Array(0);
        store.put(record);
      }
    }
    return done(tx);
  };

  const { backend, forceClose } = replicatedBackend({
    kind: "indexeddb",
    name,
    inner,
    target: { applyBatch, close: async () => db.close() },
    flushDebounceMs,
    onFlushError,
    release,
  });

  // If another tab deletes or upgrades the database, stop replicating
  // rather than blocking it; the working tree stays usable for export.
  db.onversionchange = () => {
    db.close();
    forceClose();
  };

  return backend;
}

/** Delete a filesystem's database. Close any open backend for it first. */
export async function destroyIndexedDBFilesystem(name: string): Promise<void> {
  assertIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_PREFIX + name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB deletion failed"));
  });
}
