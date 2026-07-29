import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { importWorkspaceSandbox, sharedFs } from "./sandbox";
import { chatMessages, seedChat } from "./agent/chats";
import type { StudioUIMessage } from "./agent/chats";
import { useStudio, type AgentSession, type BackendKind } from "./store";
import { DEFAULT_MODELS, type Provider } from "./models";

/**
 * sandbox.zip layout:
 *   manifest.json      — format marker, sandbox name, session order
 *   workspace.tar      — the full filesystem tree (fs.export())
 *   sessions/<id>.json — one open agent session with its transcript
 */
interface Manifest {
  format: "boxsh-sandbox";
  version: 1;
  name: string;
  sessions: string[];
}

interface SessionFile {
  provider: Provider;
  model: string;
  title: string;
  messages: StudioUIMessage[];
}

export async function exportSandboxArchive(): Promise<Blob> {
  const { sandboxName, sessions } = useStudio.getState();
  const fs = await sharedFs();
  const tar = new Uint8Array(await fs.export());

  const manifest: Manifest = {
    format: "boxsh-sandbox",
    version: 1,
    name: sandboxName,
    sessions: sessions.map((s) => s.id),
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "workspace.tar": tar,
  };
  for (const s of sessions) {
    const file: SessionFile = {
      provider: s.provider,
      model: s.model,
      title: s.title,
      messages: chatMessages(s.id),
    };
    files[`sessions/${s.id}.json`] = strToU8(JSON.stringify(file));
  }
  return new Blob([zipSync(files)], { type: "application/zip" });
}

const parseJson = (bytes: Uint8Array, entry: string): unknown => {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error(`The archive's ${entry} is not valid JSON.`);
  }
};

export async function importSandboxArchive(
  bytes: Uint8Array,
  kind: BackendKind,
): Promise<void> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a zip archive.");
  }
  if (!entries["manifest.json"] || !entries["workspace.tar"]) {
    throw new Error(
      "This zip is not a sandbox export — it needs manifest.json and workspace.tar.",
    );
  }
  const manifest = parseJson(entries["manifest.json"], "manifest.json") as Manifest;
  if (manifest.format !== "boxsh-sandbox") {
    throw new Error("This zip is not a sandbox export.");
  }

  await importWorkspaceSandbox(kind, manifest.name || "imported", entries["workspace.tar"]);

  const store = useStudio.getState();
  for (const id of manifest.sessions ?? []) {
    const raw = entries[`sessions/${id}.json`];
    if (!raw) continue;
    const file = parseJson(raw, `sessions/${id}.json`) as SessionFile;
    const provider: Provider = file.provider === "openai" ? "openai" : "anthropic";
    const session: Omit<AgentSession, "id"> = {
      provider,
      model:
        typeof file.model === "string" && file.model
          ? file.model
          : DEFAULT_MODELS[provider],
      title: typeof file.title === "string" ? file.title : "Imported session",
    };
    const sessionId = store.addImportedSession(session);
    seedChat(sessionId, Array.isArray(file.messages) ? file.messages : []);
  }
}
