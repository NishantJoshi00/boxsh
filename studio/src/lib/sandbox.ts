import {
  Filesystem,
  Sandbox,
  loadEngine,
  wasmMemory,
  indexeddb,
  opfs,
  destroyIndexedDBFilesystem,
  destroyOpfsFilesystem,
  type BoxshEngine,
  type StorageBackend,
} from "@boxsh/sandbox";
import commandsUrl from "@boxsh/sandbox/engine/commands.wasm?url";
// Imported as an asset (not left to the package's import.meta.url default)
// so Vite serves it in dev — the symlinked package sits outside the dev
// server's fs allow-list, and only module-graph files escape that check.
import fsWasmUrl from "@boxsh/sandbox/engine/fs.wasm?url";
import {
  useStudio,
  type BackendKind,
  type PersistentBackendKind,
  type SavedSandbox,
} from "./store";
import { generateSandboxId, generateSandboxName } from "./names";
import { DATA_ROOT, initializeSkillWorkspace } from "./skills";

export type BackendSwitchMode = "migrate" | "abandon";

const fsModule = () => new URL(fsWasmUrl, window.location.href);

function createBackend(kind: BackendKind, id: string): Promise<StorageBackend> {
  switch (kind) {
    case "indexeddb":
      return indexeddb({ name: id, module: fsModule() });
    case "opfs":
      return opfs({ name: id, module: fsModule() });
    default:
      return wasmMemory({ module: fsModule() });
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
    const studio = useStudio.getState();
    let backend: StorageBackend;
    try {
      backend = await createBackend(studio.backendKind, studio.sandboxId);
    } catch (err) {
      backendInitError = err instanceof Error ? err.message : String(err);
      studio.activateSandbox({
        id: generateSandboxId(),
        name: generateSandboxName(),
        backendKind: "memory",
      });
      backend = await wasmMemory({ module: fsModule() });
    }
    const [fs, engine] = await Promise.all([
      Filesystem.create({ backend }),
      loadEngine({
        commands: new URL(commandsUrl, window.location.href),

      }),
    ]);
    await initializeSkillWorkspace(fs);
    const active = useStudio.getState();
    if (active.backendKind !== "memory") {
      active.activateSandbox({
        id: active.sandboxId,
        name: active.sandboxName,
        backendKind: active.backendKind,
      });
    }
    return { fs, engine };
  })();
  return ready;
}

type LiveFilesystem = Filesystem & {
  readonly backendRef: { current: StorageBackend };
};

async function openBackend(fs: Filesystem, next: StorageBackend): Promise<void> {
  const nextFs = await Filesystem.create({ backend: next });
  try {
    await initializeSkillWorkspace(nextFs);
  } catch (err) {
    await next.close();
    throw err;
  }

  const previous = fs.backend;
  (fs as LiveFilesystem).backendRef.current = next;
  try {
    await previous.close();
  } catch (err) {
    console.warn("Previous storage backend did not close cleanly", err);
  }
}

/**
 * Create a sandbox on another backend. Migration keeps the current identity
 * and copies its tree; abandoning starts a fresh sandbox and leaves persistent
 * storage registered for later.
 */
export async function switchWorkspaceBackend(
  kind: BackendKind,
  mode: BackendSwitchMode = "migrate",
): Promise<void> {
  const { fs } = await initSandbox();
  const studio = useStudio.getState();
  if (mode === "migrate" && kind === studio.backendKind) return;

  const target = {
    id: mode === "migrate" ? studio.sandboxId : generateSandboxId(),
    name: mode === "migrate" ? studio.sandboxName : generateSandboxName(),
    backendKind: kind,
  };
  const next = await createBackend(target.backendKind, target.id);

  if (mode === "migrate") {
    try {
      await fs.switchBackend(next);
    } catch (err) {
      // Closing the previous backend can fail after the live switch succeeds.
      if (fs.backend !== next) {
        try {
          await next.close();
        } catch (closeErr) {
          console.warn("New storage backend did not close cleanly", closeErr);
        }
        throw err;
      }
      console.warn("Previous storage backend did not close cleanly", err);
    }
  } else {
    await openBackend(fs, next);
  }

  useStudio.getState().activateSandbox(target);
}

/** Open a saved sandbox without copying the current workspace into it. */
export async function openWorkspaceSandbox(sandbox: SavedSandbox): Promise<void> {
  const studio = useStudio.getState();
  if (
    studio.sandboxId === sandbox.id &&
    studio.backendKind === sandbox.backendKind
  ) {
    return;
  }
  const { fs } = await initSandbox();
  await openBackend(fs, await createBackend(sandbox.backendKind, sandbox.id));
  useStudio.getState().activateSandbox(sandbox);
}

async function destroyWorkspaceBackend(
  id: string,
  backendKind: PersistentBackendKind,
): Promise<void> {
  if (backendKind === "indexeddb") {
    await destroyIndexedDBFilesystem(id);
  } else {
    await destroyOpfsFilesystem(id);
  }
}

/** Permanently remove a saved sandbox, moving to fresh memory first if active. */
export async function trashWorkspaceSandbox(sandbox: SavedSandbox): Promise<void> {
  const studio = useStudio.getState();
  if (
    studio.sandboxId === sandbox.id &&
    studio.backendKind === sandbox.backendKind
  ) {
    const { fs } = await initSandbox();
    const fresh = {
      id: generateSandboxId(),
      name: generateSandboxName(),
      backendKind: "memory" as const,
    };
    await openBackend(fs, await createBackend(fresh.backendKind, fresh.id));
    useStudio.getState().activateSandbox(fresh);
  }

  await destroyWorkspaceBackend(sandbox.id, sandbox.backendKind);
  useStudio
    .getState()
    .removeSavedSandbox(sandbox.id, sandbox.backendKind);
}

/** Find Boxsh filesystems even when the local registry was cleared or predates it. */
export async function discoverWorkspaceSandboxes(): Promise<
  Pick<SavedSandbox, "id" | "backendKind">[]
> {
  const discovered: Pick<SavedSandbox, "id" | "backendKind">[] = [];

  if (typeof indexedDB.databases === "function") {
    try {
      for (const database of await indexedDB.databases()) {
        if (database.name?.startsWith("boxsh-fs:")) {
          discovered.push({
            id: database.name.slice("boxsh-fs:".length),
            backendKind: "indexeddb",
          });
        }
      }
    } catch {
      // Discovery is optional; opening a registered sandbox still works.
    }
  }

  if (typeof navigator.storage?.getDirectory === "function") {
    try {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle("boxsh-fs");
      for await (const [id, handle] of base.entries()) {
        if (handle.kind === "directory") {
          discovered.push({ id, backendKind: "opfs" });
        }
      }
    } catch {
      // The Boxsh OPFS directory does not exist yet, or cannot be enumerated.
    }
  }

  return discovered;
}

export async function createSession(cwd = DATA_ROOT): Promise<Sandbox> {
  const { fs, engine } = await initSandbox();
  return new Sandbox({ fs, engine, cwd });
}

export async function sharedFs(): Promise<Filesystem> {
  return (await initSandbox()).fs;
}
