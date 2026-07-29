import {
  BoxshError,
  Filesystem,
  Sandbox,
  destroyIndexedDBFilesystem,
  destroyOpfsFilesystem,
  indexeddb,
  loadEngine,
  memory,
  normalize,
  opfs,
  tarfile,
  wasmMemory,
  type BackendEntry,
  type BoxshEngine,
  type DirEntry,
  type EngineSource,
  type ErrnoCode,
  type ExecOutput,
  type FilesystemOptions,
  type IndexedDBBackendOptions,
  type LoadEngineOptions,
  type OpfsBackendOptions,
  type SandboxOptions,
  type StorageBackend,
  type TarBackendOptions,
  type WasmMemoryBackendOptions,
} from "@boxsh/sandbox";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type IsAny<T> = 0 extends 1 & T ? true : false;

declare const filesystem: Filesystem;
declare const engine: BoxshEngine;

const binaryRead = filesystem.readFile("/workspace/data.bin");
const textRead = filesystem.readFile("/workspace/data.txt", "utf-8");
const entries = filesystem.readdir("/workspace");
const result = new Sandbox({ fs: filesystem, engine }).exec("pwd");

type BinaryReadIsExact = Assert<Equal<Awaited<typeof binaryRead>, Uint8Array>>;
type TextReadIsExact = Assert<Equal<Awaited<typeof textRead>, string>>;
type EntriesAreExact = Assert<Equal<Awaited<typeof entries>, DirEntry[]>>;
type ExecIsExact = Assert<Equal<Awaited<typeof result>, ExecOutput>>;
type ExecStdoutIsNotAny = Assert<Equal<IsAny<ExecOutput["stdout"]>, false>>;
type EntryKindIsExact = Assert<Equal<BackendEntry["kind"], "file" | "dir">>;
type ErrorCodeIsExact = Assert<
  Equal<ErrnoCode, "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL">
>;

const customBackend: StorageBackend = {
  kind: "custom",
  read: () => undefined,
  write: () => {},
  entry: () => undefined,
  list: () => [],
  mkdir: () => {},
  remove: () => {},
  rename: () => {},
  flush: async () => {},
  close: async () => {},
};

const filesystemOptions: FilesystemOptions = { backend: customBackend };
const sandboxOptions: SandboxOptions = {
  fs: filesystem,
  engine,
  env: { USER: "agent" },
  cwd: "/workspace",
};
const loadOptions: LoadEngineOptions = {
  commands: new URL("https://example.com/commands.wasm"),
};
const indexedDBOptions: IndexedDBBackendOptions = {
  name: "workspace",
  lock: "exclusive",
  onFlushError(error: unknown) {
    void error;
  },
};
const opfsOptions: OpfsBackendOptions = { name: "workspace", lock: "none" };
const wasmOptions: WasmMemoryBackendOptions = {};
const tarOptions: TarBackendOptions = {
  tar: new Uint8Array(),
  async onFlush(archive: Uint8Array) {
    void archive;
  },
};

const engineSources: EngineSource[] = [
  "https://example.com/commands.wasm",
  new URL("https://example.com/commands.wasm"),
  new Uint8Array(),
];

void Filesystem.create(filesystemOptions);
void new Sandbox(sandboxOptions);
void loadEngine(loadOptions);
void loadEngine();
void memory();
void indexeddb(indexedDBOptions);
void opfs(opfsOptions);
void wasmMemory(wasmOptions);
void tarfile(tarOptions);
void destroyIndexedDBFilesystem("workspace");
void destroyOpfsFilesystem("workspace");
void normalize("/workspace/../data");
void new BoxshError("ENOENT", "/missing");
void engineSources;

// @ts-expect-error Only UTF-8 text decoding is supported.
void filesystem.readFile("/workspace/data.txt", "ascii");

// @ts-expect-error Environment values must be strings.
void new Sandbox({ fs: filesystem, engine, env: { RETRIES: 3 } });

// @ts-expect-error A named IndexedDB filesystem is required.
void indexeddb({});

// @ts-expect-error Unsupported lock modes must not be widened to string.
void opfs({ name: "workspace", lock: "shared" });

// @ts-expect-error Explicit engine options require a command source.
void loadEngine({});

// @ts-expect-error Numbers are not WebAssembly module sources.
void loadEngine({ commands: 42 });

// @ts-expect-error Custom backends must implement the complete contract.
const incompleteBackend: StorageBackend = { kind: "incomplete" };
void incompleteBackend;

export type PublicTypeAssertions =
  | BinaryReadIsExact
  | TextReadIsExact
  | EntriesAreExact
  | ExecIsExact
  | ExecStdoutIsNotAny
  | EntryKindIsExact
  | ErrorCodeIsExact;
