# Getting started

boxsh runs shell commands against a virtual filesystem owned by your
application. It works in Node.js and modern browsers without using the host
shell or host filesystem.

## Install

```sh
npm install @boxsh/sandbox
```

boxsh requires Node.js 20 or newer. Browser applications need a bundler that
supports `new URL(..., import.meta.url)` asset references.

## Run your first command

```js
import { Filesystem, Sandbox, loadEngine, wasmMemory } from "@boxsh/sandbox";

const engine = await loadEngine();
const filesystem = await Filesystem.create({ backend: await wasmMemory() });

await filesystem.mkdir("/workspace");
await filesystem.writeFile(
  "/workspace/data.txt",
  "pear\napple\nbanana\n",
);

const sandbox = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/workspace",
});

const result = await sandbox.exec("sort data.txt | head -2");

console.log(result.stdout); // "apple\nbanana\n"
console.log(result.code);   // 0
```

`exec()` returns:

```ts
{
  stdout: string;
  stderr: string;
  code: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}
```

Use the string properties for text and the byte properties for binary output.
Non-zero command exits are returned as results rather than thrown as
exceptions. Environment variables and the working directory persist across
calls to the same `Sandbox`.

## Use boxsh in the browser

The same JavaScript API works with bundlers such as Vite, webpack 5, and
Rollup. The bundled WebAssembly modules are emitted as assets and fetched the
first time `loadEngine()` runs.

To load the command modules from a CDN or another location instead:

```js
const engine = await loadEngine({
  commands: "https://cdn.example.com/boxsh/commands.wasm",
});
```

The full command module is approximately 2.8 MB over the wire with gzip, or
2 MB with Brotli. It is loaded once and can be cached like any other static
asset.

The optimized command module uses WebAssembly SIMD. If a target runtime does
not support SIMD, omit `optimizedCommands`; all commands remain available
through the standard module.

## TypeScript

boxsh includes its own type declarations. No separate `@types` package is
needed. Runtime values and their related public types are available from the
same package entrypoint:

```ts
import { Filesystem, loadEngine, wasmMemory } from "@boxsh/sandbox";
import type {
  EngineSource,
  ExecOutput,
  LoadEngineOptions,
  StorageBackend,
} from "@boxsh/sandbox";
```

The declarations support strict Node ESM and browser/bundler projects. Method
overloads preserve useful inference—for example, `readFile(path)` returns
`Promise<Uint8Array>`, while `readFile(path, "utf-8")` returns
`Promise<string>`.

## Next steps

- Read the [JavaScript API](api.md).
- Review [shell syntax and available commands](commands.md).
- Explore [recipes and behavior](behavior.md).
