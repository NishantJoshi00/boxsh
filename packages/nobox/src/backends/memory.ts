import type { BackendEntry, StorageBackend } from "../backend.js";
import { parentOf } from "../backend.js";
import { eexist, enoent, enotdir, enotempty, eisdir } from "../errors.js";

interface Node {
  data?: Uint8Array;
  dir?: true;
  mtime: number;
}

/** Create a non-persistent in-memory storage backend. */
export function memory(): StorageBackend {
  const nodes = new Map<string, Node>([["", { dir: true, mtime: Date.now() }]]);

  const childrenOf = (dir: string): string[] =>
    [...nodes.keys()].filter(
      (k) =>
        k !== "" &&
        k.startsWith(dir === "" ? "" : dir + "/") &&
        !k.slice(dir === "" ? 0 : dir.length + 1).includes("/"),
    );

  const requireParent = (path: string): void => {
    const parent = nodes.get(parentOf(path));
    if (!parent) throw enoent(parentOf(path));
    if (!parent.dir) throw enotdir(parentOf(path));
  };

  return {
    kind: "memory",

    read(path) {
      return nodes.get(path)?.data;
    },

    write(path, data) {
      const existing = nodes.get(path);
      if (existing?.dir) throw eisdir(path);
      if (!existing) requireParent(path);
      nodes.set(path, { data, mtime: Date.now() });
    },

    entry(path): BackendEntry | undefined {
      const n = nodes.get(path);
      if (!n) return undefined;
      return { kind: n.dir ? "dir" : "file", size: n.data?.length ?? 0, mtime: n.mtime };
    },

    list(path) {
      const n = nodes.get(path);
      if (!n?.dir) return undefined;
      return childrenOf(path).map((k) => k.split("/").pop() as string);
    },

    mkdir(path) {
      if (nodes.has(path)) throw eexist(path);
      requireParent(path);
      nodes.set(path, { dir: true, mtime: Date.now() });
    },

    remove(path) {
      const n = nodes.get(path);
      if (!n) throw enoent(path);
      if (n.dir && childrenOf(path).length > 0) throw enotempty(path);
      nodes.delete(path);
    },

    rename(from, to) {
      const n = nodes.get(from);
      if (!n) throw enoent(from);
      requireParent(to);
      nodes.set(to, n);
      nodes.delete(from);
      if (n.dir) {
        for (const k of [...nodes.keys()]) {
          if (k.startsWith(from + "/")) {
            nodes.set(to + k.slice(from.length), nodes.get(k) as Node);
            nodes.delete(k);
          }
        }
      }
    },

    async flush() {},
    async close() {},
  };
}
