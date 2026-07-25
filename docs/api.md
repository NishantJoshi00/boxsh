# JavaScript API

The public package exports `Filesystem`, `Sandbox`, `loadEngine`, `memory`,
`NoboxError`, `normalize`, and the related TypeScript types.

## `loadEngine`

```ts
function loadEngine(source: {
  commands: string | BufferSource | WebAssembly.Module;
  optimizedCommands?: string | BufferSource | WebAssembly.Module;
}): Promise<NoboxEngine>;
```

Loads the command modules used by a `Sandbox`.

- `commands` is required.
- `optimizedCommands` is optional.
- A source may be a URL, a buffer, or an already compiled
  `WebAssembly.Module`.

In Node.js, pass buffers returned by `readFileSync()`. In a browser, pass URLs
or fetched buffers.

## `Filesystem`

Create a filesystem with a storage backend:

```js
const filesystem = await Filesystem.create({
  backend: memory(),
});
```

Paths may be absolute or relative to the filesystem root. They are normalized
before reaching the backend.

### `readFile`

```ts
readFile(path: string): Promise<Uint8Array>;
readFile(path: string, encoding: "utf-8"): Promise<string>;
```

Reads a file as bytes or UTF-8 text.

### `writeFile`

```ts
writeFile(path: string, data: Uint8Array | string): Promise<void>;
```

Creates or replaces a file. Its parent directory must already exist.

### `readdir`

```ts
readdir(path: string): Promise<DirEntry[]>;
```

Returns entries sorted by name:

```ts
interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}
```

`mtime` is expressed in milliseconds since the Unix epoch.

### `stat`

```ts
stat(path: string): Promise<BackendEntry>;
```

Returns `kind`, `size`, and `mtime` for a path.

### `exists`

```ts
exists(path: string): Promise<boolean>;
```

Returns whether a path exists.

### `mkdir`

```ts
mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
```

Creates a directory. Set `recursive` to create missing parent directories.

### `rm`

```ts
rm(path: string, options?: { recursive?: boolean }): Promise<void>;
```

Removes a file or empty directory. Set `recursive` to remove a directory tree.

### `rename`

```ts
rename(from: string, to: string): Promise<void>;
```

Renames a file or directory.

### `export` and `import`

```ts
export(): Promise<Uint8Array>;
import(archive: Uint8Array): Promise<void>;
```

`export()` returns the complete filesystem as a TAR archive. `import()` merges
an archive into the current filesystem and replaces files with matching paths.

```js
const archive = await filesystem.export();

const restored = await Filesystem.create({ backend: memory() });
await restored.import(archive);
```

### `switchBackend`

```ts
switchBackend(next: StorageBackend): Promise<void>;
```

Copies the current filesystem into another backend, flushes it, makes it
active, and closes the previous backend. Existing `Sandbox` instances attached
to the filesystem use the new backend automatically.

The copy merges into the destination rather than clearing it. See
[Backend switching](behavior.md#backend-switching) for migration and failure
semantics.

### `flush`

```ts
flush(): Promise<void>;
```

Asks the active backend to make prior writes durable.

## `Sandbox`

```ts
new Sandbox({
  fs: Filesystem;
  engine: NoboxEngine;
  env?: Record<string, string>;
  cwd?: string;
});
```

The environment and working directory persist across calls to `exec()` on the
same sandbox.

```js
const sandbox = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/workspace",
  env: {
    HOME: "/workspace",
    USER: "agent",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  },
});
```

If `env` is omitted, nobox provides defaults for `HOME`, `USER`, `PATH`,
`TERM`, `SHELL`, and `LANG`.

### `exec`

```ts
exec(script: string): Promise<ExecOutput>;
```

Runs one or more shell lines and buffers their output:

```ts
interface ExecOutput {
  stdout: string;
  stderr: string;
  code: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}
```

Use the string properties for text and the byte properties for binary output.
Command failures and non-zero exits are returned in `ExecOutput`. Setup and
programming errors may still reject the promise.

### `cwd`

```ts
get cwd(): string;
set cwd(path: string);
```

Reads or changes the sandbox working directory.

### `env`

```ts
readonly env: Record<string, string>;
```

The object is readonly, but its entries may be changed:

```js
sandbox.env.DEBUG = "1";
delete sandbox.env.DEBUG;
```

## Storage backends

`memory()` creates the built-in non-persistent backend.

Applications may provide another backend by implementing `StorageBackend`:

```ts
interface StorageBackend {
  readonly kind: string;

  read(path: string): Uint8Array | undefined;
  write(path: string, data: Uint8Array): void;
  entry(path: string): BackendEntry | undefined;
  list(path: string): string[] | undefined;
  mkdir(path: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;

  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Backend paths are normalized, have no leading slash, and use the empty string
for the root. File operations are synchronous. `flush()` and `close()` may
perform asynchronous durability and cleanup work.

Backends should throw `NoboxError` for expected filesystem failures.

## Errors

Filesystem operations throw `NoboxError`:

```js
try {
  await filesystem.readFile("/missing.txt");
} catch (error) {
  if (error instanceof NoboxError && error.code === "ENOENT") {
    console.log(`${error.path} does not exist`);
  }
}
```

Available error codes are:

- `ENOENT`
- `EEXIST`
- `ENOTDIR`
- `EISDIR`
- `ENOTEMPTY`
- `EINVAL`

Each error exposes `code`, `path`, `message`, and the standard `Error`
properties.

## `normalize`

```ts
normalize(path: string): string;
```

Normalizes a user path into backend form:

```js
normalize("/a/./b/../c"); // "a/c"
normalize("/");           // ""
```

See [Recipes, behavior, and current quirks](behavior.md) for byte ownership,
archive fidelity, shared filesystem patterns, and other observable details.
