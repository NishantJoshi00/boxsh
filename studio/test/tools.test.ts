/** Agent tools against the real wasm engine — plain Node script, no framework. */
import assert from "node:assert/strict";
import { Filesystem, Sandbox, loadEngine, wasmMemory } from "@boxsh/sandbox";
import { makeTools } from "../src/lib/agent/tools";

const engineDir = new URL("../../packages/boxsh/engine/", import.meta.url);
const engine = await loadEngine({
  commands: new URL("commands.wasm", engineDir),
  optimizedCommands: new URL("commands-optimized.wasm", engineDir),
});
const fs = await Filesystem.create({ backend: await wasmMemory() });
const session = new Sandbox({ fs, engine });

let mutations = 0;
const tools = makeTools({
  session: async () => session,
  fs: async () => fs,
  onMutate: () => mutations++,
});

const opts = { toolCallId: "t", messages: [] } as never;

/** Our tools resolve to plain objects; strip the AsyncIterable arm of execute's type. */
const call = async <T>(res: T | AsyncIterable<T> | PromiseLike<T | AsyncIterable<T>>): Promise<T> =>
  (await res) as T;

// bash: stdout and exit code
{
  const r = await call(tools.bash.execute!({ script: "echo hello | tr a-z A-Z" }, opts));
  assert.equal(r.stdout.trim(), "HELLO");
  assert.equal(r.exitCode, 0);
}

// bash: non-zero exit is a result, not an exception
{
  const r = await call(tools.bash.execute!({ script: "cat /nope" }, opts));
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.stderr.length > 0);
}

// bash: cwd persists across calls within the session
{
  await call(tools.bash.execute!({ script: "mkdir -p /work/a && cd /work/a" }, opts));
  const r = await call(tools.bash.execute!({ script: "pwd" }, opts));
  assert.equal(r.stdout.trim(), "/work/a");
}

// write_file creates parents; bash sees it (shared filesystem)
{
  const w = await call(tools.write_file.execute!(
    { path: "/proj/src/main.txt", content: "one\ntwo\n" }, opts));
  assert.equal(w.ok, true);
  const r = await call(tools.bash.execute!({ script: "wc -l < /proj/src/main.txt" }, opts));
  assert.equal(r.stdout.trim(), "2");
}

// read_file round-trip
{
  const r = await call(tools.read_file.execute!({ path: "/proj/src/main.txt" }, opts));
  assert.equal(r.content, "one\ntwo\n");
}

// edit_file: unique replacement
{
  const e = await call(tools.edit_file.execute!(
    { path: "/proj/src/main.txt", oldText: "two", newText: "2" }, opts));
  assert.deepEqual(e, { ok: true, replacements: 1 });
  const r = await call(tools.read_file.execute!({ path: "/proj/src/main.txt" }, opts));
  assert.equal(r.content, "one\n2\n");
}

// edit_file: missing text and ambiguous text are soft errors
{
  const miss = await call(tools.edit_file.execute!(
    { path: "/proj/src/main.txt", oldText: "zzz", newText: "x" }, opts));
  assert.equal(miss.ok, false);

  await call(tools.write_file.execute!({ path: "/dup.txt", content: "a a a" }, opts));
  const dup = await call(tools.edit_file.execute!(
    { path: "/dup.txt", oldText: "a", newText: "b" }, opts));
  assert.equal(dup.ok, false);
  const all = await call(tools.edit_file.execute!(
    { path: "/dup.txt", oldText: "a", newText: "b", replaceAll: true }, opts));
  assert.deepEqual(all, { ok: true, replacements: 3 });
}

assert.ok(mutations >= 6, `expected mutation notifications, got ${mutations}`);

console.log("tools.test.ts: all assertions passed");
