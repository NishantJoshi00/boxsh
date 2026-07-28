/** Manage files and directories in a configured storage backend. */
import type { BackendEntry, StorageBackend } from "./backend.js";
import { normalize } from "./backend.js";
import { enoent, enotdir } from "./errors.js";
import { tarExport, tarImport } from "./tar.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface DirEntry extends BackendEntry {
  name: string;
}

export interface FilesystemOptions {
  backend: StorageBackend;
}

export class Filesystem {
  /** @internal */
  readonly backendRef: { current: StorageBackend };

  private constructor(backend: StorageBackend) {
    this.backendRef = { current: backend };
  }

  static async create(options: FilesystemOptions): Promise<Filesystem> {
    return new Filesystem(options.backend);
  }

  get backend(): StorageBackend {
    return this.backendRef.current;
  }

  async readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, encoding: "utf-8"): Promise<string>;
  async readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string> {
    const p = normalize(path);
    const data = this.backend.read(p);
    if (data === undefined) {
      const e = this.backend.entry(p);
      if (e?.kind === "dir") throw enotdir(path);
      throw enoent(path);
    }
    return encoding === "utf-8" ? dec.decode(data) : data;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    this.backend.write(normalize(path), bytes);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const p = normalize(path);
    const names = this.backend.list(p);
    if (names === undefined) {
      if (!this.backend.entry(p)) throw enoent(path);
      throw enotdir(path);
    }
    return names.sort().map((name) => {
      const e = this.backend.entry(p === "" ? name : `${p}/${name}`) as BackendEntry;
      return { name, ...e };
    });
  }

  async stat(path: string): Promise<BackendEntry> {
    const e = this.backend.entry(normalize(path));
    if (!e) throw enoent(path);
    return e;
  }

  async exists(path: string): Promise<boolean> {
    return this.backend.entry(normalize(path)) !== undefined;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const p = normalize(path);
    if (options?.recursive) {
      let cur = "";
      for (const seg of p.split("/").filter(Boolean)) {
        cur = cur === "" ? seg : `${cur}/${seg}`;
        if (!this.backend.entry(cur)) this.backend.mkdir(cur);
      }
      return;
    }
    this.backend.mkdir(p);
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const p = normalize(path);
    const e = this.backend.entry(p);
    if (!e) throw enoent(path);
    if (e.kind === "dir" && options?.recursive) {
      for (const name of this.backend.list(p) ?? []) {
        await this.rm(p === "" ? name : `${p}/${name}`, { recursive: true });
      }
    }
    this.backend.remove(p);
  }

  async rename(from: string, to: string): Promise<void> {
    this.backend.rename(normalize(from), normalize(to));
  }

  /** The whole workspace as a tar archive. */
  async export(): Promise<Uint8Array> {
    const b = this.backend as StorageBackend & { exportTar?: () => Uint8Array };
    return b.exportTar ? b.exportTar() : tarExport(this.backend);
  }

  /** Merge a tar archive into the workspace. */
  async import(tar: Uint8Array): Promise<void> {
    const b = this.backend as StorageBackend & { importTar?: (tar: Uint8Array) => void };
    if (b.importTar) b.importTar(tar);
    else tarImport(this.backend, tar);
  }

  /** Copy everything to a new backend, then make it the active one. */
  async switchBackend(next: StorageBackend): Promise<void> {
    const from = this.backendRef.current;
    const walk = (dir: string): void => {
      for (const name of from.list(dir) ?? []) {
        const full = dir === "" ? name : `${dir}/${name}`;
        const e = from.entry(full);
        if (!e) continue;
        if (e.kind === "dir") {
          if (!next.entry(full)) next.mkdir(full);
          walk(full);
        } else {
          next.write(full, from.read(full) ?? new Uint8Array(0));
        }
      }
    };
    walk("");
    await next.flush();
    this.backendRef.current = next;
    await from.close();
  }

  async flush(): Promise<void> {
    await this.backend.flush();
  }
}
