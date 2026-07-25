// TAR archive encoding and decoding.
import type { StorageBackend } from "./backend.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCK = 512;

function octal(n: number, width: number): Uint8Array {
  const s = n.toString(8).padStart(width - 1, "0") + "\0";
  return enc.encode(s);
}

function header(name: string, size: number, mtime: number, isDir: boolean): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const nameBytes = enc.encode(isDir ? name + "/" : name);
  if (nameBytes.length > 100) {
    // split into prefix/name at a slash boundary
    const full = isDir ? name + "/" : name;
    let cut = full.lastIndexOf("/", 100);
    if (cut <= 0) cut = 100;
    h.set(enc.encode(full.slice(cut + 1)).subarray(0, 100), 0);
    h.set(enc.encode(full.slice(0, cut)).subarray(0, 155), 345);
  } else {
    h.set(nameBytes, 0);
  }
  h.set(octal(isDir ? 0o755 : 0o644, 8), 100); // mode
  h.set(octal(0, 8), 108); // uid
  h.set(octal(0, 8), 116); // gid
  h.set(octal(isDir ? 0 : size, 12), 124);
  h.set(octal(Math.floor(mtime / 1000), 12), 136);
  h.set(enc.encode("        "), 148); // checksum placeholder = spaces
  h[156] = isDir ? 0x35 : 0x30; // typeflag '5' | '0'
  h.set(enc.encode("ustar\0"), 257);
  h.set(enc.encode("00"), 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

export function tarExport(backend: StorageBackend): Uint8Array {
  const parts: Uint8Array[] = [];
  const walk = (dir: string): void => {
    for (const name of (backend.list(dir) ?? []).sort()) {
      const full = dir === "" ? name : `${dir}/${name}`;
      const e = backend.entry(full);
      if (!e) continue;
      if (e.kind === "dir") {
        parts.push(header(full, 0, e.mtime, true));
        walk(full);
      } else {
        const data = backend.read(full) ?? new Uint8Array(0);
        parts.push(header(full, data.length, e.mtime, false));
        parts.push(data);
        const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
        if (pad) parts.push(new Uint8Array(pad));
      }
    }
  };
  walk("");
  parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function cstr(buf: Uint8Array): string {
  const end = buf.indexOf(0);
  return dec.decode(end === -1 ? buf : buf.subarray(0, end));
}

/** Import entries into the backend (merge/overwrite; missing parents created). */
export function tarImport(backend: StorageBackend, tar: Uint8Array): void {
  const mkdirs = (path: string): void => {
    const segs = path.split("/").filter(Boolean);
    let cur = "";
    for (const s of segs) {
      cur = cur === "" ? s : `${cur}/${s}`;
      if (!backend.entry(cur)) backend.mkdir(cur);
    }
  };
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const prefix = cstr(h.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + cstr(h.subarray(0, 100));
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    const type = h[156];
    at += BLOCK;
    const clean = name.replace(/\/+$/, "").replace(/^\/+/, "");
    if (type === 0x35) {
      if (clean) mkdirs(clean);
    } else if (type === 0x30 || type === 0) {
      if (clean) {
        mkdirs(clean.split("/").slice(0, -1).join("/"));
        backend.write(clean, tar.slice(at, at + size));
      }
      at += Math.ceil(size / BLOCK) * BLOCK;
    } else {
      at += Math.ceil(size / BLOCK) * BLOCK; // skip links/other types
    }
  }
}
