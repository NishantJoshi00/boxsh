// Bun entry for the shared package bench: `bun bench/bun/run.mjs [--quick]`
// Same suite as bench/node — the point is comparing runtimes on equal terms.
import { runSuite } from "../shared/suite.mjs";

await runSuite({ quick: Bun.argv.includes("--quick") });
