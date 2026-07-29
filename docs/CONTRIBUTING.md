# Contributing

Thanks for considering a contribution to boxsh.

Bug reports, focused feature proposals, documentation improvements, tests, and
code changes are welcome. For substantial changes, open an issue first so the
problem and expected public behavior can be agreed on before implementation.

## Report an issue

Use [GitHub issues](https://github.com/NishantJoshi00/boxsh/issues). Include:

- What you expected
- What happened instead
- A minimal reproduction
- Node.js and browser versions when relevant
- Operating system

Please do not include secrets or private workspace data in an issue.

## Development setup

Requirements:

- Node.js 22
- The stable Rust toolchain
- Wasmtime on `PATH` for `wasm32-wasip1` Rust tests

Clone and install:

```sh
git clone https://github.com/NishantJoshi00/boxsh.git
cd boxsh
npm ci --prefix packages/boxsh
```

Build the command modules used by the JavaScript end-to-end tests:

```sh
cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/coreutils-demo/Cargo.toml

cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/playground/hot-demo/Cargo.toml
```

Build and test the JavaScript package:

```sh
npm run build --prefix packages/boxsh
npm run typecheck --prefix packages/boxsh
npm run test:types --prefix packages/boxsh
npm test --prefix packages/boxsh
```

Run the Rust checks:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

With Wasmtime installed:

```sh
cargo test --workspace --target wasm32-wasip1
```

## Repository layout

- `packages/boxsh` — public JavaScript and TypeScript API
- `crates/boxsh-core` — shared storage primitives
- `crates/boxsh-abi` — module-facing exports
- `crates/boxsh-utils` — command support
- `examples/playground` — browser shell demo
- `bench/` — benchmarks per runtime (browser, node, bun, native rust); see bench/README.md
- `examples/comparison` — local browser comparison
- `docs` — user and contributor documentation

## Contribution guidelines

- Keep public documentation focused on available behavior and how to use it.
- Put implementation rationale in code comments, tests, issues, or contributor
  documentation rather than user-facing errors and output.
- Add or update tests for observable behavior changes.
- Keep errors actionable and avoid exposing internal state unnecessarily.
- Preserve binary data as bytes across public APIs.
- Run the relevant JavaScript and Rust checks before opening a pull request.
- Keep pull requests focused; separate unrelated changes.

## Pull requests

A pull request should explain:

- The user-visible problem
- The resulting behavior
- How the change was tested
- Any compatibility or documentation impact

CI must pass before a change can be merged.

## License

Unless explicitly stated otherwise, contributions are licensed under either
Apache License 2.0 or the MIT License, at your option.
