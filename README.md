<p align="center">
  <img src="docs/assets/boxsh-logo.png" alt="boxsh logo" width="200">
</p>

<h1 align="center">boxsh</h1>

Run shell commands against an isolated virtual filesystem from JavaScript.

```js
const result = await sandbox.exec("cat /workspace/message.txt | wc -l");

console.log(result.stdout); // "2\n"
console.log(result.code);   // 0
```

boxsh gives an application two objects:

- `Filesystem` manages files, directories, archives, and storage backends.
- `Sandbox` runs shell scripts against that filesystem without using the
  machine's shell or host filesystem.

It is useful for browser tools, agent workspaces, test fixtures, and other
applications that need shell-like workflows over application-owned data.

> [!IMPORTANT]
> boxsh is experimental and is not yet published to npm. APIs may change
> before the first stable release. Do not treat it as a hardened security
> boundary.

## What works

- Text and binary file I/O
- Directories, metadata, rename, and recursive removal
- Pipes, redirects, conditionals, variables, command substitution, heredocs,
  and simple loops
- More than 70 common commands, including `cat`, `cp`, `grep`, `ls`, `mkdir`,
  `rm`, `sort`, `tail`, `tee`, and `wc`
- Persistent environment variables and working directory within a sandbox
- TAR import and export
- Live migration between compatible storage backends
- Typed filesystem errors
- Node.js and browser runtimes

The built-in `memory()` backend is non-persistent. Its contents last for the
lifetime of the JavaScript process or browser tab.

## Quick start

Node.js 22 and the stable Rust toolchain are used by CI.

```sh
git clone https://github.com/nishantjoshi/boxsh.git
cd boxsh

cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/coreutils-demo/Cargo.toml

cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/hot-demo/Cargo.toml

npm ci --prefix packages/boxsh
npm run build --prefix packages/boxsh
```

Create `example.mjs` in the repository root:

```js
import { readFileSync } from "node:fs";
import {
  Filesystem,
  Sandbox,
  loadEngine,
  memory,
} from "./packages/boxsh/dist/index.js";

const engine = await loadEngine({
  commands: readFileSync(
    "./examples/playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm",
  ),
  optimizedCommands: readFileSync(
    "./examples/playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm",
  ),
});

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
```

Run it with:

```sh
node example.mjs
```

For browser setup and a guided walkthrough, see
[Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [JavaScript API](docs/api.md)
- [Shell syntax and available commands](docs/commands.md)
- [Recipes, behavior, and current quirks](docs/behavior.md)
- [Contributing](docs/CONTRIBUTING.md)

## Current scope

boxsh currently ships a non-persistent memory backend and a focused shell
language. It is not a complete Bash implementation, and command flag coverage
varies by command. See [Shell syntax and available commands](docs/commands.md)
for the supported surface.

The JavaScript package is currently consumed from a source checkout. npm
installation instructions will be added when the package is published.

## Help and contributing

Use [GitHub issues](https://github.com/nishantjoshi/boxsh/issues) for bug
reports, feature requests, and questions. Pull requests are welcome; read the
[contribution guide](docs/CONTRIBUTING.md) before getting started.

## License

Licensed under either of:

- [Apache License 2.0](LICENSE-APACHE)
- [MIT License](LICENSE-MIT)

at your option.
