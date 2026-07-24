export * from "./api.js";

/**
 * The hand-written nobox loader (invariant #9 / D11).
 *
 * No wasm-bindgen, no generated glue: the engine is a bare wasm32-wasip1
 * module whose imports we implement here. The import object is derived from
 * the module's own import section — syscalls we implement are wired in,
 * anything else gets an ENOSYS stub that logs on first use, so missing
 * functionality fails loudly instead of silently.
 *
 * M0 scope: instantiate, version handshake, buffer alloc. The VFS-backed
 * syscall layer (D4) replaces the stubs milestone by milestone.
 */

const WASI_MODULE = "wasi_snapshot_preview1";
const ESUCCESS = 0;
const ENOSYS = 52;

/** Thrown when guest code calls proc_exit. */
export class ProcExit extends Error {
  constructor(readonly code: number) {
    super(`guest called proc_exit(${code})`);
  }
}

export interface NoboxInstance {
  /** ABI version reported by the module; must match what this loader speaks. */
  abiVersion: number;
  /** Allocate `len` bytes in linear memory (guest-owned; pair with free). */
  alloc(len: number): number;
  /** Free a buffer from alloc(). */
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

export async function load(wasm: BufferSource | WebAssembly.Module): Promise<NoboxInstance> {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);

  let memory: WebAssembly.Memory | undefined;
  const view = () => new DataView((memory as WebAssembly.Memory).buffer);

  // Syscalls with real M0 implementations. Everything else: loud ENOSYS.
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
      throw new Error(`nobox module wants unexpected import ${im.module}.${im.name}`);
    }
    wasiImports[im.name] =
      implemented[im.name] ??
      ((...args: number[]) => {
        console.warn(`nobox: unimplemented syscall ${im.name}(${args.join(", ")})`);
        return ENOSYS;
      });
  }

  const instance = new WebAssembly.Instance(module, { [WASI_MODULE]: wasiImports });
  const exports = instance.exports as Exports;
  memory = exports.memory;
  exports._initialize?.();

  const abiVersion = exports.nobox_abi_version();
  if (abiVersion !== SUPPORTED_ABI_VERSION) {
    throw new Error(
      `nobox ABI mismatch: module speaks v${abiVersion}, loader speaks v${SUPPORTED_ABI_VERSION}`,
    );
  }

  return {
    abiVersion,
    alloc: (len) => exports.nobox_alloc(len),
    free: (ptr, len) => exports.nobox_free(ptr, len),
    memory: exports.memory,
  };
}
