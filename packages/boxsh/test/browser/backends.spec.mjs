// Real-browser coverage for the two persistent backends.
//
// test/idb.mjs already covers the shared write-behind scheduler in Node
// against fake-indexeddb. What it cannot cover is the part that only exists
// in a browser: the actual IndexedDB and OPFS storage calls, survival across
// a page reload (a fresh wasm filesystem hydrating from stored state), and
// Web Lock contention between two tabs of the same origin.
//
// Both backends expose the same contract, so every scenario is parameterized
// over ["indexeddb", "opfs"]. Filesystem names are unique per test so a
// failure leaves no state for the next one.
import { test, expect } from "@playwright/test";

const FIXTURE = "/test/browser/fixture.html";
const BACKENDS = ["indexeddb", "opfs"];

// Installed into every page before navigation. Keeping the handles on
// `window` lets a later evaluate() in the same page reuse an already-open
// backend — which is what the lock-contention test needs.
const installHelper = async (page) => {
  await page.addInitScript(() => {
    window.__open = async (kind, name, opts = {}) => {
      const mod = await import("/dist/index.js");
      window.__mod = mod;
      const backend = await mod[kind]({ name, ...opts });
      window.__backend = backend;
      window.__fs = await mod.Filesystem.create({ backend });
      return window.__fs;
    };
  });
};

const newPage = async (context) => {
  const page = await context.newPage();
  await installHelper(page);
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  await page.goto(FIXTURE);
  return page;
};

for (const kind of BACKENDS) {
  test.describe(kind, () => {
    let page;

    test.beforeEach(async ({ context }) => {
      page = await newPage(context);
    });

    test("files, binary bytes and mtimes survive a reload", async () => {
      const name = `roundtrip-${kind}`;

      const before = await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { flushDebounceMs: 20 });
          await fs.mkdir("/src/deep", { recursive: true });
          await fs.writeFile("/src/hello.txt", "hello boxsh\n");
          // Every byte value, so nothing is lost to text coercion anywhere
          // in the wasm <-> IndexedDB / OPFS round trip.
          await fs.writeFile("/src/deep/blob.bin", new Uint8Array(256).map((_, i) => i));
          const st = await fs.stat("/src/hello.txt");
          await window.__backend.flush();
          await window.__backend.close();
          return { mtime: st.mtime, size: st.size };
        },
        { kind, name },
      );

      await page.reload();

      const after = await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name);
          const out = {
            text: await fs.readFile("/src/hello.txt", "utf-8"),
            bytes: Array.from(await fs.readFile("/src/deep/blob.bin")),
            mtime: (await fs.stat("/src/hello.txt")).mtime,
            entries: (await fs.readdir("/src")).map((e) => `${e.name}:${e.kind}`),
            missing: await fs.exists("/nope"),
          };
          await window.__backend.close();
          return out;
        },
        { kind, name },
      );

      expect(after.text).toBe("hello boxsh\n");
      expect(after.bytes).toEqual(Array.from({ length: 256 }, (_, i) => i));
      expect(after.entries).toEqual(["deep:dir", "hello.txt:file"]);
      expect(after.missing).toBe(false);
      expect(after.mtime).toBe(before.mtime);
      expect(before.size).toBe("hello boxsh\n".length);
    });

    test("rename, delete and kind change survive a reload", async () => {
      const name = `mutate-${kind}`;

      await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { flushDebounceMs: 20 });
          await fs.mkdir("/a/nested", { recursive: true });
          await fs.writeFile("/a/f.txt", "f");
          await fs.writeFile("/a/nested/g.txt", "g");
          await fs.writeFile("/doomed.txt", "x");
          await window.__backend.flush(); // persist, then mutate on top of it

          await fs.rename("/a", "/b");
          await fs.rm("/doomed.txt");
          await fs.rm("/b/f.txt");
          await fs.mkdir("/b/f.txt"); // same path, now a directory
          await window.__backend.close();
        },
        { kind, name },
      );

      await page.reload();

      const after = await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name);
          const out = {
            oldRoot: await fs.exists("/a"),
            moved: await fs.readFile("/b/nested/g.txt", "utf-8"),
            deleted: await fs.exists("/doomed.txt"),
            kind: (await fs.stat("/b/f.txt")).kind,
            root: (await fs.readdir("/")).map((e) => e.name),
          };
          await window.__backend.close();
          return out;
        },
        { kind, name },
      );

      expect(after.oldRoot).toBe(false);
      expect(after.moved).toBe("g");
      expect(after.deleted).toBe(false);
      expect(after.kind).toBe("dir");
      expect(after.root).toEqual(["b"]);
    });

    test("background drain persists an abandoned tab's writes", async () => {
      const name = `behind-${kind}`;

      await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { flushDebounceMs: 20 });
          await fs.mkdir("/notes");
          await fs.writeFile("/notes/auto.txt", "drained");
          // No flush(), no close(): only the debounced write-behind runs.
          await new Promise((r) => setTimeout(r, 300));
        },
        { kind, name },
      );

      await page.reload(); // tab goes away mid-session

      const after = await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name);
          const text = await fs.readFile("/notes/auto.txt", "utf-8");
          await window.__backend.close();
          return text;
        },
        { kind, name },
      );

      expect(after).toBe("drained");
    });

    test("a second tab is locked out until the first closes", async ({ context }) => {
      const name = `lock-${kind}`;

      await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { flushDebounceMs: 20 });
          await fs.writeFile("/locked.txt", "held");
          await window.__backend.flush();
        },
        { kind, name },
      );

      const second = await newPage(context);
      const rejection = await second.evaluate(
        async ({ kind, name }) => {
          try {
            await window.__open(kind, name);
            return null;
          } catch (err) {
            return String(err?.message ?? err);
          }
        },
        { kind, name },
      );
      expect(rejection).toContain("already open in another tab");

      await page.evaluate(() => window.__backend.close());

      // The lock manager hands the lock over asynchronously; retry briefly
      // rather than racing a fixed sleep.
      const text = await second.evaluate(
        async ({ kind, name }) => {
          for (let i = 0; ; i++) {
            try {
              const fs = await window.__open(kind, name);
              const out = await fs.readFile("/locked.txt", "utf-8");
              await window.__backend.close();
              return out;
            } catch (err) {
              if (i >= 40) throw err;
              await new Promise((r) => setTimeout(r, 50));
            }
          }
        },
        { kind, name },
      );
      expect(text).toBe("held");

      await second.close();
    });

    test("lock: none lets two tabs open the same name", async ({ context }) => {
      const name = `unlocked-${kind}`;

      await page.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { lock: "none", flushDebounceMs: 20 });
          await fs.writeFile("/shared.txt", "one");
          await window.__backend.flush();
        },
        { kind, name },
      );

      const second = await newPage(context);
      const text = await second.evaluate(
        async ({ kind, name }) => {
          const fs = await window.__open(kind, name, { lock: "none" });
          const out = await fs.readFile("/shared.txt", "utf-8");
          await window.__backend.close();
          return out;
        },
        { kind, name },
      );
      expect(text).toBe("one");

      await second.close();
      await page.evaluate(() => window.__backend.close());
    });

    test("destroy leaves an empty root behind", async () => {
      const name = `gone-${kind}`;

      const entries = await page.evaluate(
        async ({ kind, name }) => {
          const destroy =
            kind === "opfs" ? "destroyOpfsFilesystem" : "destroyIndexedDBFilesystem";
          const fs = await window.__open(kind, name, { flushDebounceMs: 20 });
          await fs.mkdir("/keep");
          await fs.writeFile("/keep/f.txt", "x");
          await window.__backend.flush();
          await window.__backend.close();

          await window.__mod[destroy](name);

          const fs2 = await window.__open(kind, name);
          const out = {
            root: await fs2.readdir("/"),
            existed: await fs2.exists("/keep/f.txt"),
          };
          await window.__backend.close();
          return out;
        },
        { kind, name },
      );

      expect(entries.root).toEqual([]);
      expect(entries.existed).toBe(false);
    });
  });
}

// The scenarios above would also pass if the data never left the page, so
// these two look at the store directly: the browser must actually hold it.
test.describe("store shape", () => {
  test("opfs stores a real file tree plus the mtime sidecar", async ({ context }) => {
    const page = await newPage(context);
    const out = await page.evaluate(async () => {
      const fs = await window.__open("opfs", "shape", { flushDebounceMs: 20 });
      await fs.mkdir("/dir");
      await fs.writeFile("/dir/leaf.txt", "leaf");
      await window.__backend.flush();
      await window.__backend.close();

      const root = await navigator.storage.getDirectory();
      const base = await (await root.getDirectoryHandle("boxsh-fs")).getDirectoryHandle("shape");
      const paths = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          paths.push(prefix + name);
          if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
        }
      };
      await walk(base, "");
      const metaText = await (await (await base.getFileHandle("meta.json")).getFile()).text();
      const leaf = await (
        await (
          await (await base.getDirectoryHandle("tree")).getDirectoryHandle("dir")
        ).getFileHandle("leaf.txt")
      ).getFile();
      return { paths: paths.sort(), meta: JSON.parse(metaText), leaf: await leaf.text() };
    });

    expect(out.paths).toEqual(["meta.json", "tree", "tree/dir", "tree/dir/leaf.txt"]);
    expect(out.leaf).toBe("leaf"); // bytes on disk, readable without boxsh
    expect(out.meta.formatVersion).toBe(1);
    expect(Object.keys(out.meta.mtimes).sort()).toEqual(["dir", "dir/leaf.txt"]);
  });

  test("indexeddb stores one record per path in a named database", async ({ context }) => {
    const page = await newPage(context);
    const out = await page.evaluate(async () => {
      const fs = await window.__open("indexeddb", "shape", { flushDebounceMs: 20 });
      await fs.mkdir("/dir");
      await fs.writeFile("/dir/leaf.txt", "leaf");
      await window.__backend.flush();
      await window.__backend.close();

      const names = (await indexedDB.databases()).map((d) => d.name);
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("boxsh-fs:shape");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const records = await new Promise((resolve, reject) => {
        const req = db.transaction("entries").objectStore("entries").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return {
        names,
        stores: records
          .map((r) => `${r.path}:${r.kind}`)
          .sort(),
        leaf: new TextDecoder().decode(
          records.find((r) => r.path === "dir/leaf.txt").data,
        ),
      };
    });

    expect(out.names).toContain("boxsh-fs:shape");
    expect(out.stores).toEqual(["dir/leaf.txt:file", "dir:dir"]);
    expect(out.leaf).toBe("leaf");
  });
});
