// Minimal static file server for the browser tests. Serves the package
// directory (packages/boxsh) as-is so that dist/ and engine/ keep their
// published relative layout — the backends resolve their wasm module with
// `new URL("../../engine/fs.wasm", import.meta.url)`, which only works when
// dist/backends/*.js and engine/*.wasm are served from the same tree.
//
// Dependency-free on purpose: node:http only. http://localhost is a secure
// context, so OPFS is available without TLS.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, normalize, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env.PORT ?? 8391);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

const contentType = (path) => {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : TYPES[path.slice(dot)]) ?? "application/octet-stream";
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // Resolve inside ROOT; normalize() collapses any ".." before the check.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": contentType(file),
    "content-length": stat.size,
    // Cross-origin isolation is not required for OPFS/IndexedDB, but the
    // headers keep the fixture close to a real app shell.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`);
});
