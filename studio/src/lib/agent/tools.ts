import { tool } from "ai";
import { z } from "zod";
import type { Filesystem, Sandbox } from "@boxsh/sandbox";
import { loadInstalledSkill } from "../skills";
import { trackCommand } from "../telemetry";

const MAX_OUTPUT = 32_000;

const clip = (s: string) =>
  s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n[output truncated]" : s;

export interface ToolDeps {
  /** Shell session for bash — cwd/env persist across calls. */
  session: () => Promise<Sandbox>;
  /** The shared filesystem for direct file tools. */
  fs: () => Promise<Filesystem>;
  /** Called after anything mutates the filesystem. */
  onMutate?: () => void;
}

/** The agent toolset over the boxsh sandbox. */
export function makeTools({ session, fs, onMutate }: ToolDeps) {
  const mutated = () => onMutate?.();

  return {
    bash: tool({
      description:
        "Run a shell script in the sandbox (pipes, redirects, loops, heredocs " +
        "supported; ~70 coreutils available). Returns stdout, stderr, and the " +
        "exit code. The working directory and environment persist between calls.",
      inputSchema: z.object({
        script: z.string().describe("Shell script to execute"),
      }),
      execute: async ({ script }) => {
        let r;
        try {
          r = await (await session()).exec(script);
        } catch (err) {
          trackCommand({
            source: "agent",
            script,
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        mutated();
        trackCommand({
          source: "agent",
          script,
          exitCode: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
        });
        return {
          stdout: clip(r.stdout),
          stderr: clip(r.stderr),
          exitCode: r.code,
        };
      },
    }),

    read_file: tool({
      description: "Read a file from the sandbox filesystem as UTF-8 text.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of the file"),
      }),
      execute: async ({ path }) => {
        return { content: clip(await (await fs()).readFile(path, "utf-8")) };
      },
    }),

    write_file: tool({
      description:
        "Write a file in the sandbox filesystem, creating parent directories " +
        "and replacing any existing content.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of the file"),
        content: z.string().describe("Full file content"),
      }),
      execute: async ({ path, content }) => {
        const f = await fs();
        const dir = path.replace(/\/[^/]*$/, "");
        if (dir) await f.mkdir(dir, { recursive: true });
        await f.writeFile(path, content);
        mutated();
        return { ok: true, bytes: new TextEncoder().encode(content).length };
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact text snippet in a file. The old text must occur " +
        "exactly once unless replaceAll is set.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of the file"),
        oldText: z.string().describe("Exact text to replace"),
        newText: z.string().describe("Replacement text"),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace every occurrence (default: false)"),
      }),
      execute: async ({ path, oldText, newText, replaceAll }) => {
        const f = await fs();
        const content = await f.readFile(path, "utf-8");
        const count = content.split(oldText).length - 1;
        if (count === 0) {
          return { ok: false, error: "oldText not found in file" };
        }
        if (count > 1 && !replaceAll) {
          return {
            ok: false,
            error: `oldText occurs ${count} times; make it unique or set replaceAll`,
          };
        }
        const next = replaceAll
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);
        await f.writeFile(path, next);
        mutated();
        return { ok: true, replacements: replaceAll ? count : 1 };
      },
    }),

    load_skill: tool({
      description:
        "Load the full instructions for an installed Agent Skill. Call this " +
        "before using a matching skill advertised in the system prompt.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .describe("Lowercase skill name from the available skills list"),
      }),
      execute: async ({ name }) => loadInstalledSkill(await fs(), name),
    }),
  };
}

export type StudioTools = ReturnType<typeof makeTools>;
