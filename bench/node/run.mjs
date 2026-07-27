// Node entry for the shared package bench: `node bench/node/run.mjs [--quick]`
import { runSuite } from "../shared/suite.mjs";

await runSuite({ quick: process.argv.includes("--quick") });
