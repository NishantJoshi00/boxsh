/**
 * The storage seam (decision D17): every backend stores data its own
 * most-efficient way and implements these file-level operations. The engine
 * calls them synchronously (the WASI syscall layer must answer in the same
 * tick); backends whose native I/O is async keep state resident and write
 * behind — their `flush` is where durability happens.
 *
 * Paths at this seam are normalized: no leading slash, `""` is the root.
 */

export interface BackendEntry {
  kind: "file" | "dir";
  size: number;
  /** milliseconds since epoch */
  mtime: number;
}

export interface StorageBackend {
  readonly kind: string;

  /** File contents, or undefined if the path is missing or a directory. */
  read(path: string): Uint8Array | undefined;
  /** Create or overwrite a file. Parent directory must exist. */
  write(path: string, data: Uint8Array): void;
  /** Metadata for a path, or undefined if it does not exist. */
  entry(path: string): BackendEntry | undefined;
  /** Child names of a directory, or undefined if not a directory. */
  list(path: string): string[] | undefined;
  /** Create one directory level. Parent must exist. */
  mkdir(path: string): void;
  /** Remove a file or an empty directory. */
  remove(path: string): void;
  /** Rename a file or directory (including its subtree). */
  rename(from: string, to: string): void;

  /** Make everything written so far durable (no-op for memory). */
  flush(): Promise<void>;
  /** Flush and release resources. */
  close(): Promise<void>;
}

/** Normalize any user path to the backend form ("" = root). */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

export const parentOf = (p: string): string => p.split("/").slice(0, -1).join("/");
export const baseOf = (p: string): string => p.split("/").pop() ?? "";
