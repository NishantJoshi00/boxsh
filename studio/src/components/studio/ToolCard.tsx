import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";

export interface ToolPartLike {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function summarize(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (toolName === "bash" && typeof i.script === "string") {
    return i.script.split("\n")[0] ?? "";
  }
  return typeof i.path === "string" ? i.path : "";
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="grid gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

const isRunning = (p: ToolPartLike) =>
  p.state === "input-streaming" || p.state === "input-available";

const isFailed = (p: ToolPartLike) => {
  const output = p.output as { exitCode?: number; error?: string } | undefined;
  return (
    p.state === "output-error" ||
    Boolean(output?.error) ||
    (typeof output?.exitCode === "number" && output.exitCode !== 0)
  );
};

function describe(parts: ToolPartLike[]): string {
  const paths = (name: string) =>
    new Set(
      parts
        .filter((p) => p.type === `tool-${name}`)
        .map((p) => String((p.input as { path?: string } | undefined)?.path ?? Math.random())),
    ).size;
  const bashes = parts.filter((p) => p.type === "tool-bash").length;
  const bits: string[] = [];
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (bashes) bits.push(`ran ${plural(bashes, "command")}`);
  const wrote = paths("write_file");
  if (wrote) bits.push(`wrote ${plural(wrote, "file")}`);
  const edited = paths("edit_file");
  if (edited) bits.push(`edited ${plural(edited, "file")}`);
  const read = paths("read_file");
  if (read) bits.push(`read ${plural(read, "file")}`);
  const s = bits.join(", ") || `${parts.length} tool calls`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A run of consecutive tool calls collapses to one summary line
 * ("Ran 2 commands, wrote 3 files"); it stays open while tools are running.
 */
export function ToolGroup({ parts }: { parts: ToolPartLike[] }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (parts.length === 1) return <ToolRow part={parts[0]!} />;

  const running = parts.some(isRunning);
  const failed = parts.filter(isFailed).length;
  const open = userOpen ?? running;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <Collapsible open={open} onOpenChange={setUserOpen}>
      <CollapsibleTrigger
        className="group flex items-center gap-1.5 py-0.5 text-left text-xs text-foreground/70 hover:text-foreground"
      >
        <span>{describe(parts)}</span>
        {failed > 0 && !running && (
          <span className="text-destructive/80">· {failed} failed</span>
        )}
        {running ? (
          <Spinner className="size-3 shrink-0" />
        ) : (
          <Chevron className="size-3 shrink-0 opacity-40 group-hover:opacity-80" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-1 border-l border-border/60 pl-3">
        {parts.map((part, i) => (
          <ToolRow key={i} part={part} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolRow({ part }: { part: ToolPartLike }) {
  const [open, setOpen] = useState(false);
  const toolName = part.type.replace(/^tool-/, "");
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const output = part.output as
    | { stdout?: string; stderr?: string; exitCode?: number; content?: string; error?: string }
    | undefined;
  const exitCode = output?.exitCode;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="text-muted-foreground">
      <CollapsibleTrigger
        className="group flex w-full items-center gap-1.5 py-0.5 text-left text-xs"
      >
        <span className="shrink-0 font-medium">{toolName}</span>
        <span className="truncate font-mono text-muted-foreground/60">
          {summarize(toolName, part.input)}
        </span>
        {running ? (
          <Spinner className="size-3 shrink-0" />
        ) : (
          <>
            {(failed || output?.error || (typeof exitCode === "number" && exitCode !== 0)) && (
              <span className="shrink-0 text-destructive/80">
                {typeof exitCode === "number" && exitCode !== 0 ? `exit ${exitCode}` : "error"}
              </span>
            )}
            <Chevron className="size-3 shrink-0 opacity-40 group-hover:opacity-80" />
          </>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-1 ml-1 grid gap-2 border-l border-border/60 py-1 pl-3">
        {toolName === "bash" ? (
          <OutputBlock
            label="script"
            text={String((part.input as { script?: string } | undefined)?.script ?? "")}
          />
        ) : (
          <OutputBlock label="input" text={JSON.stringify(part.input, null, 2)} />
        )}
        {part.errorText && <OutputBlock label="error" text={part.errorText} />}
        {output?.stdout ? <OutputBlock label="stdout" text={output.stdout} /> : null}
        {output?.stderr ? <OutputBlock label="stderr" text={output.stderr} /> : null}
        {output?.content !== undefined && (
          <OutputBlock label="content" text={output.content ?? ""} />
        )}
        {output?.error && <OutputBlock label="result" text={output.error} />}
        {!running && !output && !part.errorText && (
          <span className="text-xs text-muted-foreground/60">No output.</span>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
