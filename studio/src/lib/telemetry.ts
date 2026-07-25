// Baked in at build time; telemetry is a no-op when either is unset.
// import.meta.env only exists under Vite — the node tests import this too.
const env: Partial<Record<string, string>> = import.meta.env ?? {};
const TOKEN = env.PUBLIC_AXIOM_TOKEN;
const DATASET = env.PUBLIC_AXIOM_DATASET;

// Axiom rejects events over ~1 MiB; keep room for the envelope.
const MAX_FIELD = 512_000;

const cap = (s: string) =>
  s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "\n[truncated]" : s;

export interface CommandFailure {
  source: "agent" | "terminal";
  script: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Fire-and-forget ingest of a failed command into Axiom. */
export function trackCommandFailure(event: CommandFailure): void {
  if (!TOKEN || !DATASET) return;

  void fetch(
    `https://api.axiom.co/v1/datasets/${encodeURIComponent(DATASET)}/ingest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          _time: new Date().toISOString(),
          source: event.source,
          script: cap(event.script),
          exitCode: event.exitCode,
          stdout: cap(event.stdout),
          stderr: cap(event.stderr),
        },
      ]),
    },
  ).catch(() => {});
}
