import {
  Filesystem,
  Sandbox,
  loadEngine,
  wasmMemory,
  indexeddb,
  opfs,
  type BoxshEngine,
  type StorageBackend,
} from "@boxsh/sandbox";
import commandsUrl from "@boxsh/sandbox/engine/commands.wasm?url";
import optimizedUrl from "@boxsh/sandbox/engine/commands-optimized.wasm?url";
import { useStudio, type BackendKind } from "./store";
import { DATA_ROOT, initializeSkillWorkspace } from "./skills";

/** Stable name so IndexedDB/OPFS reloads rehydrate the same data. */
const FS_NAME = "studio";

function createBackend(kind: BackendKind): Promise<StorageBackend> {
  switch (kind) {
    case "indexeddb":
      return indexeddb({ name: FS_NAME });
    case "opfs":
      return opfs({ name: FS_NAME });
    default:
      return wasmMemory();
  }
}

/**
 * One shared filesystem per page load; every agent session and terminal gets
 * its own Sandbox (cwd/env) over it, so edits are visible everywhere at once.
 */
let ready: Promise<{ fs: Filesystem; engine: BoxshEngine }> | undefined;

/**
 * Set when the persisted backend failed to open on load (e.g. its Web Lock is
 * held by another tab) and we fell back to memory. Read once, after mount.
 */
let backendInitError: string | undefined;

export function consumeBackendInitError(): string | undefined {
  const error = backendInitError;
  backendInitError = undefined;
  return error;
}

export function initSandbox(): Promise<{ fs: Filesystem; engine: BoxshEngine }> {
  ready ??= (async () => {
    let backend: StorageBackend;
    try {
      backend = await createBackend(useStudio.getState().backendKind);
    } catch (err) {
      backendInitError = err instanceof Error ? err.message : String(err);
      useStudio.getState().setBackendKind("memory");
      backend = await wasmMemory();
    }
    const [fs, engine] = await Promise.all([
      Filesystem.create({ backend }),
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

/**
 * Migrate the shared filesystem to another backend. Rejects (with the current
 * backend still active and working) if the new one cannot be opened — e.g. the
 * persistent filesystem is already open in another tab.
 */
export async function switchWorkspaceBackend(kind: BackendKind): Promise<void> {
  const { fs } = await initSandbox();
  await fs.switchBackend(await createBackend(kind));
}

export async function createSession(cwd = DATA_ROOT): Promise<Sandbox> {
  const { fs, engine } = await initSandbox();
  return new Sandbox({ fs, engine, cwd });
}

export async function sharedFs(): Promise<Filesystem> {
  return (await initSandbox()).fs;
}
