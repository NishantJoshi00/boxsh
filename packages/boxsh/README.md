# boxsh

Run shell commands against an isolated virtual filesystem from JavaScript—in
Node.js or the browser. No host shell and no host filesystem.

> **Pre-release:** boxsh is experimental. APIs may change before the first
> stable release. Do not treat boxsh as a hardened security boundary.

## Install

```sh
npm install @boxsh/sandbox
```

boxsh requires Node.js 20 or newer.

## Quick start

```js
import { Filesystem, Sandbox, loadEngine, memory } from "@boxsh/sandbox";

const engine = await loadEngine();
const filesystem = await Filesystem.create({ backend: memory() });

await filesystem.mkdir("/workspace");
await filesystem.writeFile(
  "/workspace/message.txt",
  "hello\nfrom boxsh\n",
);

const sandbox = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/workspace",
});

const result = await sandbox.exec("cat message.txt | wc -l");

console.log(result.stdout); // "2\n"
console.log(result.code);   // 0
```

`Sandbox.exec()` returns standard output, standard error, and an exit code.
Non-zero command exits are returned as results rather than thrown as
exceptions.

## What boxsh provides

- Text and binary file operations
- Directories, metadata, rename, and recursive removal
- Pipes, redirects, conditionals, variables, command substitution, heredocs,
  and simple loops
- More than 70 familiar commands, including `cat`, `cp`, `grep`, `ls`, `mkdir`,
  `rm`, `sort`, `tail`, `tee`, and `wc`
- Persistent environment variables and working directory within a sandbox
- TAR import and export
- Live migration between compatible storage backends
- Typed filesystem errors
- Node.js and browser support

The built-in `memory()` backend is non-persistent. Its contents last for the
lifetime of the JavaScript process or browser tab.

## Browser support

With modern browser bundlers, `loadEngine()` serves the bundled WebAssembly
modules as assets. To load them from a CDN or another location instead:

```js
const engine = await loadEngine({
  commands: "https://cdn.example.com/boxsh/commands.wasm",
  optimizedCommands: "https://cdn.example.com/boxsh/commands-optimized.wasm",
});
```

The full command module is approximately 2.8 MB over the wire with gzip, or
2 MB with Brotli. It is loaded once and can be cached like any other static
asset.

## Documentation

- [Getting started](docs/getting-started.md)
- [JavaScript API](docs/api.md)
- [Shell syntax and available commands](docs/commands.md)
- [Recipes and behavior](docs/behavior.md)

## Current scope

boxsh provides a focused shell language rather than complete Bash
compatibility. Command flag coverage varies by command, and command output is
buffered in memory.

## License

The JavaScript and TypeScript in this package are licensed under either the
MIT License or Apache License 2.0, at your option. The bundled WebAssembly
command modules contain compiled third-party open-source code; see
`THIRD-PARTY-NOTICES.md` for attributions.
