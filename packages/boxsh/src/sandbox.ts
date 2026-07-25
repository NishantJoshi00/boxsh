/** Run shell scripts against a virtual filesystem. */
import { createEngine, type Engine, type EngineModules } from "./engine.js";
import type { Filesystem } from "./filesystem.js";
import { createShell, type ShellSession } from "./shell.js";

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

type EngineSource = string | URL | BufferSource | WebAssembly.Module;

/**
 * Load command modules. With no arguments, loads the modules bundled with
 * the package (in Node directly from disk; in browsers via fetch — bundlers
 * that understand `new URL(..., import.meta.url)` serve them as assets).
 * Pass explicit URLs or buffers to load from a CDN or custom build instead.
 */
export async function loadEngine(source?: {
  commands: EngineSource;
  optimizedCommands?: EngineSource;
}): Promise<BoxshEngine> {
  const compile = async (s: EngineSource): Promise<WebAssembly.Module> => {
    if (s instanceof WebAssembly.Module) return s;
    if (typeof s === "string" || s instanceof URL) {
      if (s instanceof URL && s.protocol === "file:") {
        const { readFile } = await import("node:fs/promises");
        return WebAssembly.compile(await readFile(s));
      }
      const resp = await fetch(s);
      if (!resp.ok) throw new Error(`Unable to load boxsh commands from ${s} (HTTP ${resp.status}).`);
      try {
        return await WebAssembly.compileStreaming(resp.clone());
      } catch {
        return WebAssembly.compile(await resp.arrayBuffer());
      }
    }
    return WebAssembly.compile(s);
  };
  const src = source ?? {
    commands: new URL("../engine/commands.wasm", import.meta.url),
    optimizedCommands: new URL("../engine/commands-optimized.wasm", import.meta.url),
  };
  return {
    cold: await compile(src.commands),
    hot:
      src.optimizedCommands !== undefined
        ? await compile(src.optimizedCommands)
        : undefined,
  } as unknown as BoxshEngine;
}

export class Sandbox {
  /** Session environment — mutate freely; persists across exec() calls. */
  readonly env: Record<string, string>;
  private readonly session: ShellSession;
  private readonly engine: Engine;
  private readonly shell: ReturnType<typeof createShell>;

  constructor(options: SandboxOptions) {
    this.env = options.env ?? {
      HOME: "/",
      USER: "agent",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TERM: "xterm-256color",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
    };
    this.session = { env: this.env, cwd: options.cwd ?? "/", lastStatus: 0 };
    this.engine = createEngine(options.engine as unknown as EngineModules, options.fs.backendRef, {
      env: this.env,
      cwd: () => this.session.cwd,
    });
    this.shell = createShell(this.engine, options.fs.backendRef, this.session);
  }

  get cwd(): string {
    return this.session.cwd;
  }

  set cwd(path: string) {
    this.session.cwd = path.startsWith("/") ? path : "/" + path;
  }

  /**
   * Run a shell script (one or more lines; heredocs supported) and return
   * its buffered output. Non-zero exit codes are results, not exceptions.
   */
  async exec(script: string): Promise<ExecOutput> {
    const r = this.shell.execScript(script);
    return {
      stdout: dec.decode(r.stdout),
      stderr: dec.decode(r.stderr),
      code: r.code,
      stdoutBytes: r.stdout,
      stderrBytes: r.stderr,
    };
  }
}
