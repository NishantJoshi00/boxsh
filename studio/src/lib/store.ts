import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateSandboxName } from "./names";
import { DEFAULT_MODELS, PROVIDER_LABELS, type Provider } from "./models";

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
  addSession: (provider: Provider) => string;
  removeSession: (id: string) => void;
  setSessionTitle: (id: string, title: string) => void;
  setSessionModel: (id: string, model: string) => void;
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
      addSession: (provider) => {
        const id = nextId();
        set((st) => ({
          sessions: [
            ...st.sessions,
            {
              id,
              provider,
              title: `New ${PROVIDER_LABELS[provider]} session`,
              model: DEFAULT_MODELS[provider],
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
