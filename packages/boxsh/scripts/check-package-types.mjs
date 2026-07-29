import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const fail = (message) => {
  throw new Error(`package types: ${message}`);
};
const normalized = (path) => path.replace(/^\.\//, "");

const legacyTypes = normalized(manifest.types ?? "");
const exportedTypes = normalized(manifest.exports?.["."]?.types ?? "");
if (!legacyTypes || legacyTypes !== exportedTypes) {
  fail(
    `"types" (${legacyTypes || "missing"}) must match exports["."].types (${exportedTypes || "missing"})`,
  );
}

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
};

const moduleNames = (directory, suffix) =>
  new Set(
    walk(directory)
      .filter((path) => path.endsWith(suffix))
      .map((path) => relative(directory, path).split("\\").join("/").slice(0, -suffix.length)),
  );

const sourceModules = moduleNames(join(root, "src"), ".ts");
for (const suffix of [".js", ".d.ts"]) {
  const outputModules = moduleNames(join(root, "dist"), suffix);
  const missing = [...sourceModules].filter((name) => !outputModules.has(name));
  const stale = [...outputModules].filter((name) => !sourceModules.has(name));
  if (missing.length || stale.length) {
    fail(
      `${suffix} output does not match src (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`,
    );
  }
}

const declarationClosure = new Set();
const visitDeclaration = (relativePath) => {
  const packagePath = relativePath.split("\\").join("/");
  if (declarationClosure.has(packagePath)) return;
  const absolutePath = join(root, packagePath);
  if (!statSync(absolutePath).isFile()) fail(`missing declaration ${packagePath}`);
  declarationClosure.add(packagePath);

  const source = readFileSync(absolutePath, "utf8");
  const imports = source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const declaration = specifier.endsWith(".js")
      ? `${specifier.slice(0, -3)}.d.ts`
      : `${specifier}.d.ts`;
    visitDeclaration(posix.normalize(posix.join(posix.dirname(packagePath), declaration)));
  }
};
visitDeclaration(exportedTypes);

const cache = mkdtempSync(join(tmpdir(), "boxsh-npm-cache-"));
let packedFiles;
try {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
    },
  );
  if (packed.status !== 0) {
    fail(`npm pack dry run failed:\n${packed.stderr || packed.stdout}`);
  }
  const report = JSON.parse(packed.stdout);
  packedFiles = new Set(report[0].files.map(({ path }) => path));
} finally {
  rmSync(cache, { recursive: true, force: true });
}

for (const declaration of declarationClosure) {
  if (!packedFiles.has(declaration)) fail(`${declaration} is absent from the npm package`);
  const map = `${declaration}.map`;
  if (!packedFiles.has(map)) fail(`${map} is absent from the npm package`);
}

console.log(
  `package types OK: ${declarationClosure.size} reachable declarations, clean output, npm export map verified`,
);
