// Browser coverage for the persistent backends. The Node suite (test/idb.mjs)
// exercises the replication scheduler against fake-indexeddb; this one runs
// the real IndexedDB and OPFS storage calls in Chromium, including page
// reloads and cross-tab Web Lock contention, which cannot be simulated in Node.
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8391);

export default defineConfig({
  testDir: ".",
  fullyParallel: false, // the backends share per-origin storage
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ${JSON.stringify(fileURLToPath(new URL("serve.mjs", import.meta.url)))}`,
    url: `http://127.0.0.1:${PORT}/test/browser/fixture.html`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    env: { PORT: String(PORT) },
  },
});
