// Tar-file persistence: a workspace that opens from a tar archive and hands
// the updated archive back on flush. The tree and the ustar codec both live
// in the Rust wasm module; this adapter only moves archive bytes. Useful as
// a snapshot/seed backend anywhere — browsers, Node, tests.
import type { StorageBackend } from "../backend.js";
import { compileModule, load, type ModuleSource } from "../loader.js";
import { wasmFilesystem } from "./wasmfs.js";

export interface TarBackendOptions {
  /** Initial contents; an empty workspace when omitted. */
  tar?: Uint8Array;
  /** Filesystem wasm module; defaults to the one bundled with the package. */
  module?: ModuleSource;
  /**
   * Receives the current archive on every `flush()` and on `close()` —
   * write it to disk, offer it as a download, store it wherever. Without
   * it the backend is effectively a seeded in-memory workspace.
   */
  onFlush?: (tar: Uint8Array) => void | Promise<void>;
}

/** Open a filesystem seeded from (and flushed back to) a tar archive. */
export async function tarfile(options: TarBackendOptions = {}): Promise<StorageBackend> {
  const moduleSource = options.module ?? new URL("../../engine/fs.wasm", import.meta.url);
  const inner = wasmFilesystem(await load(await compileModule(moduleSource)));
  if (options.tar) inner.importTar(options.tar);
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("This tar filesystem is closed.");
  };

  const flush = async (): Promise<void> => {
    await options.onFlush?.(inner.exportTar());
  };

  return {
    kind: "tarfile",
    wasm: inner.wasm,
    exportTar: () => {
      assertOpen();
      return inner.exportTar();
    },
    importTar: (tar: Uint8Array) => {
      assertOpen();
      inner.importTar(tar);
    },

    read(path) {
      assertOpen();
      return inner.read(path);
    },
    write(path, data) {
      assertOpen();
      inner.write(path, data);
    },
    entry(path) {
      assertOpen();
      return inner.entry(path);
    },
    list(path) {
      assertOpen();
      return inner.list(path);
    },
    mkdir(path) {
      assertOpen();
      inner.mkdir(path);
    },
    remove(path) {
      assertOpen();
      inner.remove(path);
    },
    rename(from, to) {
      assertOpen();
      inner.rename(from, to);
    },

    async flush() {
      assertOpen();
      await flush();
    },
    async close() {
      if (closed) return;
      try {
        await flush();
      } finally {
        closed = true;
        await inner.close();
      }
    },
  } as StorageBackend;
}