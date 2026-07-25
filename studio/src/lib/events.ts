type Listener = () => void;

const listeners = new Set<Listener>();

/** Fired after anything mutates the sandbox filesystem (agent tool, terminal command). */
export function onFsChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitFsChanged(): void {
  for (const fn of listeners) fn();
}
