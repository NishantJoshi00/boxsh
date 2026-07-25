# boxsh

Run shell commands against an isolated virtual filesystem from JavaScript —
in the browser or Node. No host shell, no host filesystem.

```js
import { Filesystem, Sandbox, loadEngine, memory } from "boxsh";

const engine = await loadEngine(); // bundled wasm command modules

const fs = await Filesystem.create({ backend: memory() });
await fs.mkdir("/workspace");
await fs.writeFile("/workspace/message.txt", "hello\nfrom boxsh\n");

const sandbox = new Sandbox({ fs, engine, cwd: "/workspace" });

const result = await sandbox.exec("cat message.txt | wc -l");
console.log(result.stdout); // "2\n"
console.log(result.code);   // 0
```

boxsh gives an application two objects:

- `Filesystem` manages files, directories, archives, and storage backends.
- `Sandbox` runs shell scripts against that filesystem without touching the
  machine's shell or host filesystem.

It is useful for browser tools, agent workspaces, test fixtures, and other
applications that need shell-like workflows over application-owned data.

> **Experimental.** APIs may change before 1.0. Do not treat boxsh as a
> hardened security boundary.

## What works

- Text and binary file I/O (`Uint8Array`-safe end to end)
- Directories, metadata, rename, recursive removal, typed errors
- Pipes, redirects, conditionals, variables, command substitution, heredocs,
  and simple loops
- More than 70 common commands (`cat`, `cp`, `grep`, `ls`, `mkdir`, `rm`,
  `sort`, `tail`, `tee`, `wc`, …)
- Persistent env and working directory within a sandbox session
- TAR import/export; live migration between storage backends

The built-in `memory()` backend is non-persistent: contents last for the
lifetime of the JavaScript process or browser tab. Persistent backends
(OPFS) are in development.

## Install

```sh
npm install boxsh
```

`loadEngine()` with no arguments uses the wasm command modules shipped in
the package. In Node they are read from disk; in browsers they resolve via
`new URL(..., import.meta.url)`, which bundlers such as Vite serve as
assets. To load from a CDN or a custom build instead:

```js
const engine = await loadEngine({
  commands: "https://cdn.example.com/boxsh/commands.wasm",
  optimizedCommands: "https://cdn.example.com/boxsh/commands-optimized.wasm",
});
```

Payload note: the full command module is ~2.8 MB gzipped over the wire
(~2 MB brotli). It loads once and caches like any static asset.

## Documentation

- [Getting started](https://github.com/nishantjoshi/boxsh/blob/main/docs/getting-started.md)
- [JavaScript API](https://github.com/nishantjoshi/boxsh/blob/main/docs/api.md)
- [Shell syntax and available commands](https://github.com/nishantjoshi/boxsh/blob/main/docs/commands.md)
- [Recipes, behavior, and current quirks](https://github.com/nishantjoshi/boxsh/blob/main/docs/behavior.md)

## License

MIT OR Apache-2.0, at your option.
