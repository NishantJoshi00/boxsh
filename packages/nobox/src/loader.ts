const WASI_MODULE = "wasi_snapshot_preview1";
const ESUCCESS = 0;
const ENOSYS = 52;

export class ProcExit extends Error {
  constructor(readonly code: number) {
    super(`Process exited with code ${code}`);
  }
}

export interface NoboxInstance {
  abiVersion: number;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  memory: WebAssembly.Memory;
}

export const SUPPORTED_ABI_VERSION = 1;

type Exports = {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  nobox_abi_version: () => number;
  nobox_alloc: (len: number) => number;
  nobox_free: (ptr: number, len: number) => void;
};

export async function load(
  wasm: BufferSource | WebAssembly.Module,
): Promise<NoboxInstance> {
  const module =
    wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);

  let memory: WebAssembly.Memory | undefined;
  const view = () => new DataView((memory as WebAssembly.Memory).buffer);

  const implemented: Record<string, (...args: number[]) => number> = {
    environ_sizes_get(countPtr, bufSizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(bufSizePtr, 0, true);
      return ESUCCESS;
    },
    environ_get() {
      return ESUCCESS;
    },
    proc_exit(code) {
      throw new ProcExit(code);
    },
    sched_yield() {
      return ESUCCESS;
    },
  };

  const wasiImports: Record<string, (...args: number[]) => number> = {};
  for (const im of WebAssembly.Module.imports(module)) {
    if (im.module !== WASI_MODULE) {
      throw new Error(
        `Incompatible nobox engine: unsupported import ${im.module}.${im.name}`,
      );
    }
    wasiImports[im.name] = implemented[im.name] ?? (() => ENOSYS);
  }

  const instance = new WebAssembly.Instance(module, {
    [WASI_MODULE]: wasiImports,
  });
  const exports = instance.exports as Exports;
  memory = exports.memory;
  exports._initialize?.();

  const abiVersion = exports.nobox_abi_version();
  if (abiVersion !== SUPPORTED_ABI_VERSION) {
    throw new Error(
      `Incompatible nobox engine: expected version ${SUPPORTED_ABI_VERSION}, received ${abiVersion}. Use an engine built for this nobox version.`,
    );
  }

  return {
    abiVersion,
    alloc: (len) => exports.nobox_alloc(len),
    free: (ptr, len) => exports.nobox_free(ptr, len),
    memory: exports.memory,
  };
}
