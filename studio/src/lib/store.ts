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
  lastProvider: Provider;
  lastModels: Record<Provider, string>;
  keysOpen: boolean;
  skillsOpen: boolean;

  setSandboxName: (name: string) => void;
  addSession: () => string;
  removeSession: (id: string) => void;
  setSessionTitle: (id: string, title: string) => void;
  setSessionModel: (id: string, model: string) => void;
  setSessionProvider: (id: string, provider: Provider) => void;
  setView: (view: WorkspaceView) => void;
  setKey: (provider: Provider, key: string) => void;
  setKeysOpen: (open: boolean) => void;
  setSkillsOpen: (open: boolean) => void;
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
      lastProvider: "anthropic",
      lastModels: { ...DEFAULT_MODELS },
      keysOpen: false,
      skillsOpen: false,

      setSandboxName: (sandboxName) => set({ sandboxName }),
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
    }),
    {
      name: "boxsh-studio",
      partialize: (st) => ({
        sandboxName: st.sandboxName,
        keys: st.keys,
        lastProvider: st.lastProvider,
        lastModels: st.lastModels,
      }),
    },
  ),
);
