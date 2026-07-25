// prepack step: copy the user-facing docs into the package so the tarball
// is self-contained (no links to a source repository).
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// getting-started.md is NOT synced: the repo version documents a source
// checkout; the package ships its own npm-oriented guide.
mkdirSync(p("../docs"), { recursive: true });
for (const name of ["api.md", "commands.md", "behavior.md"]) {
  copyFileSync(p(`../../../docs/${name}`), p(`../docs/${name}`));
  console.log(`docs: ${name}`);
}
