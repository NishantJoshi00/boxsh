export const SHORTCUTS = [
  {
    id: "new-session",
    label: "New session",
    keys: ["N"],
    code: "KeyN",
  },
  {
    id: "terminal",
    label: "Open terminal",
    keys: ["T"],
    code: "KeyT",
  },
  {
    id: "files",
    label: "Open files",
    keys: ["F"],
    code: "KeyF",
  },
  {
    id: "api-keys",
    label: "API keys",
    keys: ["K"],
    code: "KeyK",
  },
  {
    id: "skills",
    label: "Add skills",
    keys: ["S"],
    code: "KeyS",
  },
  {
    id: "model-picker",
    label: "Choose model",
    keys: ["M"],
    code: "KeyM",
  },
  {
    id: "composer",
    label: "Focus message input",
    keys: ["I"],
    code: "KeyI",
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    keys: ["?"],
    code: "Slash",
    shift: true,
  },
  {
    id: "leave-input",
    label: "Leave typing focus",
    keys: ["Esc"],
    code: "Escape",
  },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export function shortcut(id: ShortcutId) {
  return SHORTCUTS.find((item) => item.id === id)!;
}

export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const item = shortcut(id);
  return (
    event.code === item.code &&
    !event.ctrlKey &&
    !event.altKey &&
    event.shiftKey === ("shift" in item && item.shift === true) &&
    !event.metaKey
  );
}

export function sessionShortcutKeys(index: number): string[] {
  return [String(index + 1)];
}

export function sessionShortcutIndex(event: KeyboardEvent): number | null {
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) - 1 : null;
}

export function matchesGlobalHelpShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === "Slash" &&
    event.shiftKey &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
