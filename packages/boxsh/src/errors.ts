/** Typed filesystem errors — branch on `code` like you would in Node. */
export type ErrnoCode =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EINVAL";

export class BoxshError extends Error {
  constructor(
    readonly code: ErrnoCode,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code}: ${path}`);
    this.name = "BoxshError";
  }
}

export const enoent = (p: string) => new BoxshError("ENOENT", p, `ENOENT: no such file or directory: ${p}`);
export const eexist = (p: string) => new BoxshError("EEXIST", p, `EEXIST: file exists: ${p}`);
export const enotdir = (p: string) => new BoxshError("ENOTDIR", p, `ENOTDIR: not a directory: ${p}`);
export const eisdir = (p: string) => new BoxshError("EISDIR", p, `EISDIR: is a directory: ${p}`);
export const enotempty = (p: string) => new BoxshError("ENOTEMPTY", p, `ENOTEMPTY: directory not empty: ${p}`);
