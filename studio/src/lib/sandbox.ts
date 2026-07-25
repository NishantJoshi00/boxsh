import {
  Filesystem,
  Sandbox,
  loadEngine,
  memory,
  type BoxshEngine,
} from "@boxsh/sandbox";
import commandsUrl from "@boxsh/sandbox/engine/commands.wasm?url";
import optimizedUrl from "@boxsh/sandbox/engine/commands-optimized.wasm?url";
import { DATA_ROOT, initializeSkillWorkspace } from "./skills";

/**
 * One shared filesystem per page load; every agent session and terminal gets
 * its own Sandbox (cwd/env) over it, so edits are visible everywhere at once.
 */
let ready: Promise<{ fs: Filesystem; engine: BoxshEngine }> | undefined;

export function initSandbox(): Promise<{ fs: Filesystem; engine: BoxshEngine }> {
  ready ??= (async () => {
    const [fs, engine] = await Promise.all([
      Filesystem.create({ backend: memory() }),
      loadEngine({
        commands: new URL(commandsUrl, window.location.href),
        optimizedCommands: new URL(optimizedUrl, window.location.href),
      }),
    ]);
    await initializeSkillWorkspace(fs);
    return { fs, engine };
  })();
  return ready;
}

export async function createSession(cwd = DATA_ROOT): Promise<Sandbox> {
  const { fs, engine } = await initSandbox();
  return new Sandbox({ fs, engine, cwd });
}

export async function sharedFs(): Promise<Filesystem> {
  return (await initSandbox()).fs;
}
