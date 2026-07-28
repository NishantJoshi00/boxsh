/** Run shell scripts against a virtual filesystem. The shell itself lives
 * in Rust (boxsh-shell, inside the filesystem wasm module); this class
 * ferries the session — env, cwd, last status — across the boundary per
 * exec and adapts the command engine as the module's host. */
import { createEngine, type EngineModules } from "./engine.js";
import type { Filesystem } from "./filesystem.js";
import {
  compileModule,
  decodePathList,
  encodePathList,
  type BoxshInstance,
  type CommandHost,
  type ModuleSource,
} from "./loader.js";
import type { WasmFsInfo } from "./backends/wasmfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
declare const engineBrand: unique symbol;

/** Command modules ready to use with a Sandbox. */
export interface BoxshEngine {
  readonly [engineBrand]: true;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  code: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}

export interface SandboxOptions {
  fs: Filesystem;
  engine: BoxshEngine;
  env?: Record<string, string>;
  cwd?: string;
}

type EngineSource = ModuleSource;

type ShellExports = {
  boxsh_fs_set_time?: (handle: number, nowMs: bigint) => number;
  boxsh_shell_exec?: (
    handle: number,
    env: number,
    envLen: number,
    cwd: number,
    cwdLen: number,
    lastStatus: number,
    script: number,
    scriptLen: number,
    out: number,
  ) => number;
};

/**
 * Load the command module. With no arguments, loads the module bundled with
 * the package (in Node directly from disk; in browsers via fetch — bundlers
 * that understand `new URL(..., import.meta.url)` serve it as an asset).
 * Pass an explicit URL or buffer to load from a CDN or custom build.
 *
 * `optimizedCommands` is accepted for compatibility and ignored: the
 * optimized commands now live inside the sandbox module itself.
 */
export async function loadEngine(source?: {
  commands: EngineSource;
  optimizedCommands?: EngineSource;
}): Promise<BoxshEngine> {
  const src = source ?? { commands: new URL("../engine/commands.wasm", import.meta.url) };
  return { cold: await compileModule(src.commands) } as unknown as BoxshEngine;
}

export class Sandbox {
  /** Session environment — mutate freely; persists across exec() calls. */
  readonly env: Record<string, string>;
  private cwdState: string;
  private lastStatus = 0;
  private readonly fs: Filesystem;
  private readonly host: CommandHost;

  constructor(options: SandboxOptions) {
    this.env = options.env ?? {
      HOME: "/",
      USER: "agent",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TERM: "xterm-256color",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
    };
    this.cwdState = options.cwd ?? "/";
    this.fs = options.fs;
    const engine = createEngine(options.engine as unknown as EngineModules, options.fs.backendRef);
    this.host = {
      knows: (name) => engine.knows(name),
      run: (argv, stdin, env, cwd) => engine.run(argv, stdin, env, cwd),
    };
  }

  get cwd(): string {
    return this.cwdState;
  }

  set cwd(path: string) {
    this.cwdState = path.startsWith("/") ? path : "/" + path;
  }

  private wasmInfo(): WasmFsInfo {
    const backend = this.fs.backendRef.current as { wasm?: WasmFsInfo };
    if (!backend.wasm) {
      throw new Error(
        "Sandbox needs a filesystem on a wasm backend (wasmMemory, indexeddb, or opfs); memory() supports direct Filesystem access only.",
      );
    }
    return backend.wasm;
  }

  /**
   * Run a shell script (one or more lines; heredocs supported) and return
   * its buffered output. Non-zero exit codes are results, not exceptions.
   */
  async exec(script: string): Promise<ExecOutput> {
    const { instance, handle } = this.wasmInfo();
    const ex = instance.exports as ShellExports;
    if (typeof ex.boxsh_shell_exec !== "function") {
      throw new Error(
        "This boxsh module has no shell exports. Rebuild the module or update the package.",
      );
    }
    instance.setHost(this.host);
    // The module has no clock; stamp it so shell/command writes carry real
    // mtimes (direct backend mutations stamp on their own path).
    ex.boxsh_fs_set_time?.(handle, BigInt(Date.now()));

    const bytes = () => new Uint8Array(instance.memory.buffer);
    const view = () => new DataView(instance.memory.buffer);
    const stage = (b: Uint8Array): number => {
      if (b.length === 0) return 0;
      const ptr = instance.alloc(b.length);
      bytes().set(b, ptr);
      return ptr;
    };
    const unstage = (ptr: number, len: number): void => {
      if (len !== 0) instance.free(ptr, len);
    };
    const takePair = (cell: number, pair: number): Uint8Array => {
      const ptr = view().getUint32(cell + pair * 8, true);
      const len = view().getUint32(cell + pair * 8 + 4, true);
      if (len === 0) return new Uint8Array(0);
      const copy = bytes().slice(ptr, ptr + len);
      instance.free(ptr, len);
      return copy;
    };

    const envBlob = encodePathList(Object.entries(this.env).map(([k, v]) => `${k}=${v}`));
    const cwdBytes = enc.encode(this.cwdState);
    const scriptBytes = enc.encode(script);
    const envPtr = stage(envBlob);
    const cwdPtr = stage(cwdBytes);
    const scriptPtr = stage(scriptBytes);
    const cell = instance.alloc(32);
    let code: number;
    try {
      code = ex.boxsh_shell_exec(
        handle,
        envPtr,
        envBlob.length,
        cwdPtr,
        cwdBytes.length,
        this.lastStatus,
        scriptPtr,
        scriptBytes.length,
        cell,
      );
    } finally {
      unstage(envPtr, envBlob.length);
      unstage(cwdPtr, cwdBytes.length);
      unstage(scriptPtr, scriptBytes.length);
    }
    if (code < 0) {
      instance.free(cell, 32);
      throw new Error(`boxsh shell call failed (status ${code})`);
    }
    const stdoutBytes = takePair(cell, 0);
    const stderrBytes = takePair(cell, 1);
    const envOut = decodePathList(takePair(cell, 2));
    const cwdOut = dec.decode(takePair(cell, 3));
    instance.free(cell, 32);

    for (const key of Object.keys(this.env)) delete this.env[key];
    for (const entry of envOut) {
      const eq = entry.indexOf("=");
      if (eq > 0) this.env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    this.cwdState = cwdOut;
    this.lastStatus = code;

    return {
      stdout: dec.decode(stdoutBytes),
      stderr: dec.decode(stderrBytes),
      code,
      stdoutBytes,
      stderrBytes,
    };
  }
}
