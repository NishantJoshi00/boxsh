import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";

const toolIcons: Record<string, typeof FileText> = {
  bash: SquareTerminal,
  read_file: FileText,
  write_file: FilePlus,
  edit_file: FilePen,
};

interface ToolPartLike {
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

function Section({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="rounded-md bg-muted/50 border p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

export function ToolCard({ part }: { part: ToolPartLike }) {
  const [open, setOpen] = useState(false);
  const toolName = part.type.replace(/^tool-/, "");
  const Icon = toolIcons[toolName] ?? SquareTerminal;
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const output = part.output as
    | { stdout?: string; stderr?: string; exitCode?: number; content?: string; error?: string }
    | undefined;

  const exitCode = output?.exitCode;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card text-card-foreground"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 rounded-lg">
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{toolName}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {summarize(toolName, part.input)}
        </span>
        <span className="ml-auto shrink-0">
          {running ? (
            <Spinner className="size-3.5" />
          ) : failed ? (
            <Badge variant="destructive">error</Badge>
          ) : typeof exitCode === "number" && exitCode !== 0 ? (
            <Badge variant="outline" className="text-destructive">exit {exitCode}</Badge>
          ) : output?.error ? (
            <Badge variant="outline" className="text-destructive">failed</Badge>
          ) : (
            <Badge variant="secondary">done</Badge>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 border-t px-3 py-2">
        {toolName === "bash" ? (
          <Section
            label="script"
            text={String((part.input as { script?: string } | undefined)?.script ?? "")}
          />
        ) : (
          <Section label="input" text={JSON.stringify(part.input, null, 2)} />
        )}
        {part.errorText && <Section label="error" text={part.errorText} />}
        {output?.stdout !== undefined && <Section label="stdout" text={output.stdout ?? ""} />}
        {output?.stderr ? <Section label="stderr" text={output.stderr} /> : null}
        {output?.content !== undefined && <Section label="content" text={output.content ?? ""} />}
        {output?.error && <Section label="result" text={output.error} />}
        {!running && !output && !part.errorText && (
          <span className="text-xs text-muted-foreground">No output.</span>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
