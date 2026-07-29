import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateSandboxId, generateSandboxName } from "./names";
import { DEFAULT_MODELS, type Provider } from "./models";

export interface AgentSession {
  id: string;
  provider: Provider;
  title: string;
  model: string;
}

export type BackendKind = "memory" | "indexeddb" | "opfs";
export type PersistentBackendKind = Exclude<BackendKind, "memory">;

export interface SavedSandbox {
  id: string;
  name: string;
  backendKind: PersistentBackendKind;
  lastOpenedAt: number;
}

export type WorkspaceView =
  | { kind: "empty" }
  | { kind: "session"; sessionId: string }
  | { kind: "terminal" }
  | { kind: "files" };

interface StudioState {
  sandboxId: string;
  sandboxName: string;
  backendKind: BackendKind;
  savedSandboxes: SavedSandbox[];
  sessions: AgentSession[];
  view: WorkspaceView;
  keys: Record<Provider, string>;
  lastProvider: Provider;
  lastModels: Record<Provider, string>;
  keysOpen: boolean;
  skillsOpen: boolean;
  modelPickerSessionId: string | null;

  setSandboxName: (name: string) => void;
  activateSandbox: (sandbox: {
    id: string;
    name: string;
    backendKind: BackendKind;
  }) => void;
  registerDiscoveredSandboxes: (
    sandboxes: Pick<SavedSandbox, "id" | "backendKind">[],
  ) => void;
  removeSavedSandbox: (id: string, backendKind: PersistentBackendKind) => void;
  addSession: () => string;
  addImportedSession: (session: Omit<AgentSession, "id">) => string;
  removeSession: (id: string) => void;
  setSessionTitle: (id: string, title: string) => void;
  setSessionModel: (id: string, model: string) => void;
  setSessionProvider: (id: string, provider: Provider) => void;
  setView: (view: WorkspaceView) => void;
  setKey: (provider: Provider, key: string) => void;
  setKeysOpen: (open: boolean) => void;
  setSkillsOpen: (open: boolean) => void;
  setModelPickerSessionId: (sessionId: string | null) => void;
}

let counter = 0;
const nextId = () => `session-${++counter}-${Date.now().toString(36)}`;
const savedKey = (sandbox: Pick<SavedSandbox, "id" | "backendKind">) =>
  `${sandbox.backendKind}:${sandbox.id}`;

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      sandboxId: generateSandboxId(),
      sandboxName: generateSandboxName(),
      backendKind: "memory",
      savedSandboxes: [],
      sessions: [],
      view: { kind: "empty" },
      keys: { anthropic: "", openai: "" },
      lastProvider: "anthropic",
      lastModels: { ...DEFAULT_MODELS },
      keysOpen: false,
      skillsOpen: false,
      modelPickerSessionId: null,

      setSandboxName: (sandboxName) =>
        set((st) => ({
          sandboxName,
          savedSandboxes: st.savedSandboxes.map((sandbox) =>
            sandbox.id === st.sandboxId &&
            sandbox.backendKind === st.backendKind
              ? { ...sandbox, name: sandboxName }
              : sandbox,
          ),
        })),
      activateSandbox: (sandbox) =>
        set((st) => {
          const opened: SavedSandbox | undefined =
            sandbox.backendKind === "memory"
              ? undefined
              : {
                  ...sandbox,
                  backendKind: sandbox.backendKind,
                  lastOpenedAt: Date.now(),
                };
          const savedSandboxes = opened
            ? [
                opened,
                ...st.savedSandboxes.filter(
                  (item) => savedKey(item) !== savedKey(opened),
                ),
              ]
            : st.savedSandboxes;
          return {
            sandboxId: sandbox.id,
            sandboxName: sandbox.name,
            backendKind: sandbox.backendKind,
            savedSandboxes,
            view: { kind: "empty" },
          };
        }),
      registerDiscoveredSandboxes: (sandboxes) =>
        set((st) => {
          const known = new Set(st.savedSandboxes.map(savedKey));
          const discovered = sandboxes
            .filter((sandbox) => !known.has(savedKey(sandbox)))
            .map<SavedSandbox>((sandbox) => ({
              ...sandbox,
              name:
                sandbox.id === st.sandboxId &&
                sandbox.backendKind === st.backendKind
                  ? st.sandboxName
                  : sandbox.id === "studio"
                    ? "Saved sandbox"
                    : sandbox.id,
              lastOpenedAt: 0,
            }));
          return discovered.length
            ? { savedSandboxes: [...st.savedSandboxes, ...discovered] }
            : st;
        }),
      removeSavedSandbox: (id, backendKind) =>
        set((st) => ({
          savedSandboxes: st.savedSandboxes.filter(
            (sandbox) =>
              sandbox.id !== id || sandbox.backendKind !== backendKind,
          ),
        })),
      addSession: () => {
        const id = nextId();
        set((st) => {
          const provider = st.lastProvider;
          return {
            sessions: [
              ...st.sessions,
              {
                id,
                provider,
                title: "New session",
                model: st.lastModels[provider],
              },
            ],
            view: { kind: "session", sessionId: id },
          };
        });
        return id;
      },
      addImportedSession: (session) => {
        const id = nextId();
        set((st) => ({ sessions: [...st.sessions, { ...session, id }] }));
        return id;
      },
      removeSession: (id) =>
        set((st) => ({
          sessions: st.sessions.filter((s) => s.id !== id),
          view:
            st.view.kind === "session" && st.view.sessionId === id
              ? { kind: "empty" }
              : st.view,
        })),
      setSessionTitle: (id, title) =>
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
        })),
      setSessionModel: (id, model) =>
        set((st) => {
          const session = st.sessions.find((s) => s.id === id);
          if (!session) return st;
          return {
            sessions: st.sessions.map((s) => (s.id === id ? { ...s, model } : s)),
            lastProvider: session.provider,
            lastModels: { ...st.lastModels, [session.provider]: model },
          };
        }),
      setSessionProvider: (id, provider) =>
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === id ? { ...s, provider, model: st.lastModels[provider] } : s,
          ),
          lastProvider: provider,
        })),
      setView: (view) => set({ view }),
      setKey: (provider, key) =>
        set((st) => ({ keys: { ...st.keys, [provider]: key } })),
      setKeysOpen: (keysOpen) => set({ keysOpen }),
      setSkillsOpen: (skillsOpen) => set({ skillsOpen }),
      setModelPickerSessionId: (modelPickerSessionId) => set({ modelPickerSessionId }),
    }),
    {
      name: "boxsh-studio",
      version: 1,
      migrate: (persisted) => {
        const state = persisted as Partial<StudioState>;
        const backendKind = state.backendKind ?? "memory";
        const sandboxName = state.sandboxName ?? generateSandboxName();
        const sandboxId =
          state.sandboxId ??
          (backendKind === "memory" ? generateSandboxId() : "studio");
        const savedSandboxes =
          state.savedSandboxes ??
          (backendKind === "memory"
            ? []
            : [
                {
                  id: sandboxId,
                  name: sandboxName,
                  backendKind,
                  lastOpenedAt: Date.now(),
                },
              ]);
        return {
          sandboxId,
          sandboxName,
          backendKind,
          savedSandboxes,
          keys: state.keys ?? { anthropic: "", openai: "" },
          lastProvider: state.lastProvider ?? "anthropic",
          lastModels: state.lastModels ?? { ...DEFAULT_MODELS },
        };
      },
      partialize: (st) => ({
        sandboxId: st.sandboxId,
        sandboxName: st.sandboxName,
        backendKind: st.backendKind,
        savedSandboxes: st.savedSandboxes,
        keys: st.keys,
        lastProvider: st.lastProvider,
        lastModels: st.lastModels,
      }),
    },
  ),
);
