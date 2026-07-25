# Getting started

boxsh runs shell commands against a virtual filesystem that your application
owns. Nothing touches the machine's shell or host filesystem.

## Install

```sh
npm install boxsh
```

Node.js 20 or newer, or any modern browser via a bundler.

## First script (Node.js)

```js
import { Filesystem, Sandbox, loadEngine, memory } from "boxsh";

// Loads the wasm command modules bundled with the package.
const engine = await loadEngine();

const fs = await Filesystem.create({ backend: memory() });
await fs.mkdir("/workspace");
await fs.writeFile("/workspace/data.txt", "alpha\nbeta\ngamma\n");

const sandbox = new Sandbox({ fs, engine, cwd: "/workspace" });

const r = await sandbox.exec("sort data.txt | head -2");
console.log(r.stdout); // "alpha\nbeta\n"
console.log(r.code);   // 0
```

`exec()` returns `{ stdout, stderr, code, stdoutBytes, stderrBytes }`.
Non-zero exit codes are results, not exceptions. Environment variables and
the working directory persist across `exec()` calls on one `Sandbox`.

## In the browser

The same code works under bundlers that understand
`new URL(..., import.meta.url)` asset references (Vite, webpack 5, Rollup).
The wasm modules are emitted as assets and fetched on first `loadEngine()`.

To serve the modules from a CDN or custom location instead:

```js
const engine = await loadEngine({
  commands: "https://cdn.example.com/boxsh/commands.wasm",
  optimizedCommands: "https://cdn.example.com/boxsh/commands-optimized.wasm",
});
```

The full command module is ~2.8 MB gzipped (~2 MB brotli); it loads once and
caches like any static asset. No COOP/COEP headers, no SharedArrayBuffer —
boxsh works in a plain `<iframe>`.

## TypeScript

boxsh is written in TypeScript and ships strict type declarations,
declaration maps, and source — go-to-definition lands in real source files.
No `@types/*` package is needed.

## Next steps

- [JavaScript API](api.md) — `Filesystem`, `Sandbox`, backends, errors
- [Shell syntax and available commands](commands.md)
- [Recipes, behavior, and current quirks](behavior.md)
