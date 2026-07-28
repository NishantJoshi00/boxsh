// Doc quick-starts must actually run (regression: every primary example
// once constructed a Sandbox on memory(), which Sandbox rejects). Each
// file's first ```js block is executed verbatim against the built package
// and the bundled engine — if a doc rots, this fails.
// Run after: npm run build && npm run build:engine (bundled modules).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const pkgUrl = pathToFileURL(p("../dist/index.js")).href;

const docs = ["../../../README.md", "../README.md", "../../../docs/getting-started.md"];

for (const rel of docs) {
  const source = readFileSync(p(rel), "utf-8");
  const match = /```js\n([\s\S]*?)```/.exec(source);
  if (!match) throw new Error(`${rel}: no \`\`\`js block found`);
  const snippet = match[1].replaceAll("@boxsh/sandbox", pkgUrl);
  const module = `data:text/javascript;base64,${Buffer.from(snippet).toString("base64")}`;
  try {
    await import(module);
  } catch (e) {
    console.error(`quick-start in ${rel} is broken:`);
    throw e;
  }
  console.log(`docs OK: ${rel.split("/").pop() === "README.md" && rel.includes("../../..") ? "root README" : rel.replace(/^(\.\.\/)+/, "")}`);
}
console.log("docs quick-starts OK");
