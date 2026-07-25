# Getting started

This guide builds nobox from a source checkout, runs a first script in Node.js,
and starts the browser playground.

## Requirements

- Node.js 22
- The stable Rust toolchain
- A browser with WebAssembly support for the playground

The repository's `rust-toolchain.toml` installs the `wasm32-wasip1` target,
`rustfmt`, and Clippy automatically when using rustup.

## Build from source

Clone the repository:

```sh
git clone https://github.com/nishantjoshi/nobox.git
cd nobox
```

Build the command modules:

```sh
cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/coreutils-demo/Cargo.toml

cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/hot-demo/Cargo.toml
```

Build the JavaScript package:

```sh
npm ci --prefix packages/nobox
npm run build --prefix packages/nobox
```

The generated JavaScript and type declarations are written to
`packages/nobox/dist`.

## Run a script in Node.js

Create `example.mjs` in the repository root:

```js
import { readFileSync } from "node:fs";
import {
  Filesystem,
  Sandbox,
  loadEngine,
  memory,
} from "./packages/nobox/dist/index.js";

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
  "/workspace/fruits.txt",
  "pear\napple\nbanana\n",
);

const sandbox = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/workspace",
});

const result = await sandbox.exec("sort fruits.txt | head -2");

console.log(result.stdout);
console.error(result.stderr);
process.exitCode = result.code;
```

Run it:

```sh
node example.mjs
```

Expected output:

```text
apple
banana
```

`Sandbox.exec()` returns non-zero command exits as results rather than throwing
exceptions. See the [API reference](api.md#sandbox) for the complete return
value.

## Start the browser playground

After building the command modules, serve the repository root with any static
file server. For example:

```sh
python3 -m http.server 8420
```

Open:

- [http://localhost:8420/examples/playground/](http://localhost:8420/examples/playground/)
  for the interactive shell
- [http://localhost:8420/examples/playground/bench.html](http://localhost:8420/examples/playground/bench.html)
  for local benchmarks
- [http://localhost:8420/examples/comparison/](http://localhost:8420/examples/comparison/)
  for the browser comparison

The playground stores files in memory. Refreshing the page clears them.

## Browser API setup

In a browser, `loadEngine()` can load command modules by URL:

```js
import {
  Filesystem,
  Sandbox,
  loadEngine,
  memory,
} from "/packages/nobox/dist/index.js";

const engine = await loadEngine({
  commands:
    "/examples/playground/coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm",
  optimizedCommands:
    "/examples/playground/hot-demo/target/wasm32-wasip1/release/hot_demo.wasm",
});

const filesystem = await Filesystem.create({ backend: memory() });
const sandbox = new Sandbox({ fs: filesystem, engine });

const result = await sandbox.exec("printf 'hello from nobox\\n'");
console.log(result.stdout);
```

The server must make the JavaScript and WebAssembly files available to the
page and allow them under its content security and cross-origin policies.

## Next steps

- Learn the [JavaScript API](api.md).
- Review [shell syntax and available commands](commands.md).
- Read the [recipes and current quirks](behavior.md).
- Run the end-to-end test:

  ```sh
  npm test --prefix packages/nobox
  ```
