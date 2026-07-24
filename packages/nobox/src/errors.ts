/** Typed filesystem errors — branch on `code` like you would in Node. */
export type ErrnoCode =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EINVAL";

export class NoboxError extends Error {
  constructor(
    readonly code: ErrnoCode,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code}: ${path}`);
    this.name = "NoboxError";
  }
}

export const enoent = (p: string) => new NoboxError("ENOENT", p, `ENOENT: no such file or directory: ${p}`);
export const eexist = (p: string) => new NoboxError("EEXIST", p, `EEXIST: file exists: ${p}`);
export const enotdir = (p: string) => new NoboxError("ENOTDIR", p, `ENOTDIR: not a directory: ${p}`);
export const eisdir = (p: string) => new NoboxError("EISDIR", p, `EISDIR: is a directory: ${p}`);
export const enotempty = (p: string) => new NoboxError("ENOTEMPTY", p, `ENOTEMPTY: directory not empty: ${p}`);
