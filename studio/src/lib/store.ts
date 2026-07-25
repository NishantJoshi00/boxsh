import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateSandboxName } from "./names";
import { DEFAULT_MODELS, type Provider } from "./models";

export interface AgentSession {
  id: string;
  provider: Provider;
  title: string;
  model: string;
}

export type WorkspaceView =
  | { kind: "empty" }
  | { kind: "session"; sessionId: string }
  | { kind: "terminal" }
  | { kind: "files" };

interface StudioState {
  sandboxName: string;
  sessions: AgentSession[];
  view: WorkspaceView;
  keys: Record<Provider, string>;
  keysOpen: boolean;

  setSandboxName: (name: string) => void;
  addSession: () => string;
  removeSession: (id: string) => void;
  setSessionTitle: (id: string, title: string) => void;
  setSessionModel: (id: string, model: string) => void;
  setSessionProvider: (id: string, provider: Provider) => void;
  setView: (view: WorkspaceView) => void;
  setKey: (provider: Provider, key: string) => void;
  setKeysOpen: (open: boolean) => void;
}

let counter = 0;
const nextId = () => `session-${++counter}-${Date.now().toString(36)}`;

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      sandboxName: generateSandboxName(),
      sessions: [],
      view: { kind: "empty" },
      keys: { anthropic: "", openai: "" },
      keysOpen: false,

      setSandboxName: (sandboxName) => set({ sandboxName }),
      addSession: () => {
        const id = nextId();
        set((st) => ({
          sessions: [
            ...st.sessions,
            {
              id,
              provider: "anthropic" as const,
              title: "New session",
              model: DEFAULT_MODELS.anthropic,
            },
          ],
          view: { kind: "session", sessionId: id },
        }));
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
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === id ? { ...s, model } : s)),
        })),
      setSessionProvider: (id, provider) =>
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === id ? { ...s, provider, model: DEFAULT_MODELS[provider] } : s,
          ),
        })),
      setView: (view) => set({ view }),
      setKey: (provider, key) =>
        set((st) => ({ keys: { ...st.keys, [provider]: key } })),
      setKeysOpen: (keysOpen) => set({ keysOpen }),
    }),
    {
      name: "boxsh-studio",
      partialize: (st) => ({
        sandboxName: st.sandboxName,
        keys: st.keys,
      }),
    },
  ),
);
