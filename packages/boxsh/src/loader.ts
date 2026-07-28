const WASI_MODULE = "wasi_snapshot_preview1";
const HOST_MODULE = "boxsh_host";
const ESUCCESS = 0;
const ENOSYS = 52;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ProcExit extends Error {
  constructor(readonly code: number) {
    super(`Process exited with code ${code}`);
  }
}

/** Executes commands on behalf of the in-module shell. `env` and `cwd`
 * are the live session at the moment of invocation. */
export interface CommandHost {
  knows(name: string): boolean;
  run(
    argv: string[],
    stdin: Uint8Array,
    env: Record<string, string>,
    cwd: string,
  ): { out: Uint8Array; err: Uint8Array; code: number };
}

export interface BoxshInstance {
  abiVersion: number;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  memory: WebAssembly.Memory;
  /** Raw module exports, for feature-detected extensions of the base ABI. */
  exports: WebAssembly.Exports;
  /** Attach the command engine the module's `boxsh_host` imports call. */
  setHost(host: CommandHost | undefined): void;
}

/** Encode strings as the ABI's u32-length-prefixed list. */
export function encodePathList(items: string[]): Uint8Array {
  const encoded = items.map((s) => enc.encode(s));
  const out = new Uint8Array(encoded.reduce((n, b) => n + 4 + b.length, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const b of encoded) {
    v.setUint32(at, b.length, true);
    out.set(b, at + 4);
    at += 4 + b.length;
  }
  return out;
}

/** Decode the ABI's u32-length-prefixed string list. */
export function decodePathList(bytes: Uint8Array): string[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const len = v.getUint32(at, true);
    at += 4;
    out.push(dec.decode(bytes.subarray(at, at + len)));
    at += len;
  }
  return out;
}

export const SUPPORTED_ABI_VERSION = 1;

type Exports = {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  boxsh_abi_version: () => number;
  boxsh_alloc: (len: number) => number;
  boxsh_free: (ptr: number, len: number) => void;
};

export async function load(
  wasm: BufferSource | WebAssembly.Module,
): Promise<BoxshInstance> {
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
    // std's HashMap seeds itself from the OS RNG on first use (grep's
    // regex tables hit this); clocks are in the same always-available class.
    random_get(ptr, len) {
      crypto.getRandomValues(new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len));
      return ESUCCESS;
    },
    clock_time_get(id, prec, outP) {
      view().setBigUint64(outP, BigInt(Date.now()) * 1_000_000n, true);
      return ESUCCESS;
    },
  };

  // Command engine trampolines: the module's `boxsh_host` imports call
  // whatever engine is attached via setHost; without one, commands fail
  // with 127 and the filesystem exports still work.
  let hostRef: CommandHost | undefined;
  let exports: Exports;
  const bytesAt = (ptr: number, len: number) =>
    new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len);
  const hostImports: Record<string, (...args: number[]) => number> = {
    host_command_knows: (ptr, len) => (hostRef?.knows(dec.decode(bytesAt(ptr, len))) ? 1 : 0),
    host_command_run: (argvPtr, argvLen, stdinPtr, stdinLen, envPtr, envLen, cwdPtr, cwdLen, cellPtr) => {
      const argv = decodePathList(bytesAt(argvPtr, argvLen).slice());
      const stdin = bytesAt(stdinPtr, stdinLen).slice();
      const env: Record<string, string> = {};
      for (const entry of decodePathList(bytesAt(envPtr, envLen).slice())) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      const cwd = dec.decode(bytesAt(cwdPtr, cwdLen));
      const r = hostRef
        ? hostRef.run(argv, stdin, env, cwd)
        : {
            out: new Uint8Array(0),
            err: enc.encode(`boxsh: ${argv[0] ?? ""}: no command engine attached\n`),
            code: 127,
          };
      const stage = (b: Uint8Array): number => {
        if (b.length === 0) return 0;
        const ptr = exports.boxsh_alloc(b.length);
        bytesAt(ptr, b.length).set(b);
        return ptr;
      };
      const outPtr = stage(r.out);
      const errPtr = stage(r.err);
      const v = view();
      v.setUint32(cellPtr, outPtr, true);
      v.setUint32(cellPtr + 4, r.out.length, true);
      v.setUint32(cellPtr + 8, errPtr, true);
      v.setUint32(cellPtr + 12, r.err.length, true);
      return r.code;
    },
  };

  const wasiImports: Record<string, (...args: number[]) => number> = {};
  const hostModule: Record<string, (...args: number[]) => number> = {};
  for (const im of WebAssembly.Module.imports(module)) {
    if (im.module === WASI_MODULE) {
      wasiImports[im.name] = implemented[im.name] ?? (() => ENOSYS);
    } else if (im.module === HOST_MODULE) {
      hostModule[im.name] = hostImports[im.name] ?? (() => 0);
    } else {
      throw new Error(`Incompatible boxsh engine: unsupported import ${im.module}.${im.name}`);
    }
  }

  const instance = new WebAssembly.Instance(module, {
    [WASI_MODULE]: wasiImports,
    [HOST_MODULE]: hostModule,
  });
  exports = instance.exports as Exports;
  memory = exports.memory;
  exports._initialize?.();

  const abiVersion = exports.boxsh_abi_version();
  if (abiVersion !== SUPPORTED_ABI_VERSION) {
    throw new Error(
      `Incompatible boxsh engine: expected version ${SUPPORTED_ABI_VERSION}, received ${abiVersion}. Use an engine built for this boxsh version.`,
    );
  }

  return {
    abiVersion,
    alloc: (len) => exports.boxsh_alloc(len),
    free: (ptr, len) => exports.boxsh_free(ptr, len),
    memory: exports.memory,
    exports: instance.exports,
    setHost: (host) => {
      hostRef = host;
    },
  };
}

export type ModuleSource = string | URL | BufferSource | WebAssembly.Module;

/** Compile a wasm module from a URL, buffer, or precompiled module. */
export async function compileModule(s: ModuleSource): Promise<WebAssembly.Module> {
  if (s instanceof WebAssembly.Module) return s;
  if (typeof s === "string" || s instanceof URL) {
    if (s instanceof URL && s.protocol === "file:") {
      const { readFile } = await import("node:fs/promises");
      return WebAssembly.compile(await readFile(s));
    }
    const resp = await fetch(s);
    if (!resp.ok) throw new Error(`Unable to load boxsh module from ${s} (HTTP ${resp.status}).`);
    try {
      return await WebAssembly.compileStreaming(resp.clone());
    } catch {
      return WebAssembly.compile(await resp.arrayBuffer());
    }
  }
  return WebAssembly.compile(s);
}
