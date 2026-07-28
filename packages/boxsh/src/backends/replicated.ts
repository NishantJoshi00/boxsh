// Shared write-behind replication: drain the wasm filesystem's journal into
// a persistence target. The working tree lives in Rust (backends/wasmfs.ts);
// targets only store batches. Used by the indexeddb and opfs backends; the
// replication contract lives in boxsh-fs DESIGN.md.
import type { BackendEntry, StorageBackend } from "../backend.js";
import type { WasmFsBackend, WasmFsInfo } from "./wasmfs.js";

export interface ReplicationBatchItem {
  path: string;
  /** Present for upserts; absent for deletions. */
  entry?: BackendEntry;
  /** File bytes when `entry.kind === "file"`. */
  data?: Uint8Array;
}

export interface ReplicationTarget {
  /** Persist one batch, atomically if the medium allows. */
  applyBatch(batch: ReplicationBatchItem[]): Promise<void>;
  /** Release storage resources; called once, after the final drain. */
  close(): Promise<void>;
}

export interface ReplicatedBackendOptions {
  kind: string;
  name: string;
  inner: WasmFsBackend;
  target: ReplicationTarget;
  flushDebounceMs: number;
  onFlushError: (error: unknown) => void;
  /** Web Lock release, if one was acquired. */
  release?: () => void;
}

export interface ReplicatedBackend {
  backend: StorageBackend;
  /** Stop replicating without a final drain (storage revoked externally). */
  forceClose(): void;
}

export function replicatedBackend(options: ReplicatedBackendOptions): ReplicatedBackend {
  const { kind, name, inner, target, flushDebounceMs, onFlushError, release } = options;

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;
  let closed = false;

  const doDrain = async (): Promise<void> => {
    for (;;) {
      for (const p of inner.takeDirty()) pending.add(p);
      if (pending.size === 0) return;
      const batch = [...pending].map((path): ReplicationBatchItem => {
        const entry = inner.entry(path);
        if (!entry) return { path };
        if (entry.kind === "dir") return { path, entry };
        return { path, entry, data: inner.read(path) ?? new Uint8Array(0) };
      });
      await target.applyBatch(batch);
      for (const { path } of batch) pending.delete(path);
    }
  };
  const drain = (): Promise<void> => (inflight ??= doDrain().finally(() => (inflight = null)));

  const schedule = (delay = flushDebounceMs): void => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      drain().catch((err: unknown) => {
        onFlushError(err);
        schedule(Math.max(1000, flushDebounceMs));
      });
    }, delay);
  };

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const assertOpen = (): void => {
    if (closed) throw new Error(`Filesystem "${name}" is closed.`);
  };

  const backend: StorageBackend & {
    wasm: WasmFsInfo;
    exportTar(): Uint8Array;
    importTar(tar: Uint8Array): void;
  } = {
    kind,
    wasm: inner.wasm,

    exportTar() {
      assertOpen();
      return inner.exportTar();
    },
    importTar(tar) {
      assertOpen();
      inner.importTar(tar);
      schedule();
    },

    read(path) {
      assertOpen();
      return inner.read(path);
    },
    entry(path) {
      assertOpen();
      return inner.entry(path);
    },
    list(path) {
      assertOpen();
      return inner.list(path);
    },
    write(path, data) {
      assertOpen();
      inner.write(path, data);
      schedule();
    },
    mkdir(path) {
      assertOpen();
      inner.mkdir(path);
      schedule();
    },
    remove(path) {
      assertOpen();
      inner.remove(path);
      schedule();
    },
    rename(from, to) {
      assertOpen();
      inner.rename(from, to);
      schedule();
    },

    async flush() {
      assertOpen();
      cancelTimer();
      await drain();
    },

    async close() {
      if (closed) return;
      cancelTimer();
      try {
        await drain();
      } finally {
        closed = true;
        await target.close();
        release?.();
        await inner.close();
      }
    },
  };

  return {
    backend,
    forceClose() {
      closed = true;
      cancelTimer();
    },
  };
}

export type LockRelease = () => void;

/** Fail-fast exclusive Web Lock; undefined where Web Locks don't exist. */
export async function acquireLock(key: string, name: string): Promise<LockRelease | undefined> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return undefined; // No Web Locks here (e.g. Node tests): proceed unlocked.
  return await new Promise<LockRelease>((resolve, reject) => {
    void locks
      .request(key, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          reject(
            new Error(
              `Filesystem "${name}" is already open in another tab or context. Close it there, or open with { lock: "none" }.`,
            ),
          );
          return undefined;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}
