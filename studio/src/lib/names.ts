const adjectives = [
  "crimson", "amber", "cobalt", "jade", "ivory", "onyx", "coral", "indigo",
  "saffron", "slate", "violet", "copper", "silver", "teal", "umber", "pearl",
];

const animals = [
  "otter", "lynx", "heron", "fox", "badger", "raven", "ibex", "marten",
  "osprey", "stoat", "wren", "pika", "tern", "vole", "shrike", "newt",
];

export function generateSandboxName(): string {
  const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
  return `${pick(adjectives)}-${pick(animals)}`;
}
