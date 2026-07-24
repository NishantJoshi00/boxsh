/** The session half of the API: what you hand to an agent. */
import { createEngine, type Engine, type EngineModules } from "./engine.js";
import type { Filesystem } from "./filesystem.js";
import { createShell, type ShellSession } from "./shell.js";

const dec = new TextDecoder();

export interface ExecOutput {
  stdout: string;
  stderr: string;
  code: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}

export interface SandboxOptions {
  fs: Filesystem;
  engine: EngineModules;
  env?: Record<string, string>;
  cwd?: string;
}

/** Compile the engine's wasm modules from URLs (browser) or buffers. */
export async function loadEngine(source: {
  cold: string | BufferSource | WebAssembly.Module;
  hot?: string | BufferSource | WebAssembly.Module;
}): Promise<EngineModules> {
  const compile = async (
    s: string | BufferSource | WebAssembly.Module,
  ): Promise<WebAssembly.Module> => {
    if (s instanceof WebAssembly.Module) return s;
    if (typeof s === "string") {
      const resp = await fetch(s);
      if (!resp.ok) throw new Error(`failed to fetch engine module: ${s} (${resp.status})`);
      try {
        return await WebAssembly.compileStreaming(resp.clone());
      } catch {
        return WebAssembly.compile(await resp.arrayBuffer());
      }
    }
    return WebAssembly.compile(s);
  };
  return {
    cold: await compile(source.cold),
    hot: source.hot !== undefined ? await compile(source.hot) : undefined,
  };
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
    this.engine = createEngine(options.engine, options.fs.backendRef, {
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
