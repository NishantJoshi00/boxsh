import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowUp,
  Brain,
  ChevronRight,
  CircleAlert,
  KeyRound,
  Square,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatFor } from "@/lib/agent/chats";
import { onFsChanged } from "@/lib/events";
import { sharedFs } from "@/lib/sandbox";
import { discoverInstalledSkills, type InstalledSkill } from "@/lib/skills";
import { PROVIDER_LABELS } from "@/lib/models";
import { useStudio, type AgentSession } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ModelPickerDialog } from "./ModelPickerDialog";
import { ToolGroup, type ToolPartLike } from "./ToolCard";

const assetBase = import.meta.env.BASE_URL.replace(/\/?$/, "/");

type Segment =
  | { kind: "part"; part: { type: string }; key: number }
  | { kind: "tools"; parts: ToolPartLike[]; key: number };

/** Group consecutive tool invocations into one collapsible summary. */
function segment(parts: readonly { type: string }[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, i) => {
    // Invisible step boundaries must not break tool-run grouping.
    if (part.type === "step-start") return;
    if (part.type.startsWith("tool-")) {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.parts.push(part as unknown as ToolPartLike);
      else out.push({ kind: "tools", parts: [part as unknown as ToolPartLike], key: i });
    } else {
      out.push({ kind: "part", part, key: i });
    }
  });
  return out;
}

function SkillsLoaded() {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);

  useEffect(() => {
    let alive = true;
    const scan = () => {
      void sharedFs()
        .then(discoverInstalledSkills)
        .then((found) => {
          if (alive) setSkills(found);
        });
    };
    scan();
    const off = onFsChanged(scan);
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (skills.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="ml-auto text-xs text-muted-foreground">
            {skills.length} {skills.length === 1 ? "skill" : "skills"} loaded
          </span>
        }
      />
      <TooltipContent side="top">
        {skills.map((skill) => (
          <div key={skill.name}>{skill.name}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

const plugins = { code };
const noControls = { code: false, table: false } as const;
// Streamdown bug: with lineNumbers off, highlighted line spans render inline
// with no newlines — force each line span back to its own row.
const codeLineFix = "[&_[data-streamdown=code-block-body]_pre>code>span]:block";

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        <Brain className="size-3" />
        {streaming ? "Thinking…" : "Thought process"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l-2 pl-3 text-sm text-muted-foreground">
        <Streamdown
          plugins={plugins}
          isAnimating={streaming}
          lineNumbers={false}
          controls={noControls}
          className={codeLineFix}
        >
          {text}
        </Streamdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SessionView({ session }: { session: AgentSession }) {
  const chat = useMemo(() => chatFor(session.id), [session.id]);
  const { messages, sendMessage, stop, status, error, clearError } = useChat({ chat });
  const [input, setInput] = useState("");
  const hasKey = useStudio((st) => Boolean(st.keys[session.provider]));
  const setKeysOpen = useStudio((st) => st.setKeysOpen);
  const setSessionTitle = useStudio((st) => st.setSessionTitle);
  const bottomRef = useRef<HTMLDivElement>(null);

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  const send = () => {
    const text = input.trim();
    if (!text || busy || !hasKey) return;
    if (messages.length === 0) {
      setSessionTitle(session.id, text.length > 42 ? text.slice(0, 42) + "…" : text);
    }
    void sendMessage({ text });
    setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto max-w-3xl px-4 py-6 pt-12 grid gap-4">
          {!hasKey && (
            <Alert>
              <KeyRound />
              <AlertTitle>No {PROVIDER_LABELS[session.provider]} API key</AlertTitle>
              <AlertDescription>Add your key to start this session.</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={() => setKeysOpen(true)}>
                  Add key
                </Button>
              </AlertAction>
            </Alert>
          )}

          {messages.length === 0 && (
            <div className="grid min-h-[55vh] place-content-center justify-items-center gap-4 py-8">
              <img
                src={`${assetBase}brand/box-dither.png`}
                alt=""
                aria-hidden="true"
                className="w-full max-w-72 select-none object-contain opacity-60 invert dark:invert-0"
                draggable={false}
              />
              <h2 className="text-center text-[34.03px] font-medium leading-none tracking-tight text-muted-foreground">
                What are we building?
              </h2>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="grid gap-2">
              {m.role === "user" ? (
                <div className="justify-self-end max-w-[85%] rounded-xl bg-primary text-primary-foreground px-3.5 py-2 text-sm whitespace-pre-wrap">
                  {m.parts
                    .filter((p) => p.type === "text")
                    .map((p) => (p as { text: string }).text)
                    .join("")}
                </div>
              ) : (
                segment(m.parts).map((seg) => {
                  const i = seg.key;
                  if (seg.kind === "tools") {
                    return <ToolGroup key={i} parts={seg.parts} />;
                  }
                  const part = seg.part as {
                    type: string;
                    text: string;
                    state?: string;
                  };
                  if (part.type === "text") {
                    return (
                      <Streamdown
                        key={i}
                        plugins={plugins}
                        isAnimating={part.state === "streaming"}
                        lineNumbers={false}
                        controls={noControls}
                        className={cn("text-sm", codeLineFix)}
                      >
                        {part.text}
                      </Streamdown>
                    );
                  }
                  if (part.type === "reasoning") {
                    return part.text.trim() ? (
                      <Reasoning
                        key={i}
                        text={part.text}
                        streaming={part.state === "streaming"}
                      />
                    ) : null;
                  }
                  return null;
                })
              )}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" /> Working…
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Request failed</AlertTitle>
              <AlertDescription className="break-all">{error.message}</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={clearError}>
                  Dismiss
                </Button>
              </AlertAction>
            </Alert>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="bg-background">
        <div className="mx-auto max-w-3xl p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 rounded-[1.75rem] bg-muted/60 py-2 pl-4 pr-2 transition-colors focus-within:bg-muted/80">
            <Textarea
              id={`composer-${session.id}`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Message ${PROVIDER_LABELS[session.provider]}…`}
              className="min-h-8 min-w-0 w-full max-h-48 resize-none border-0 px-1 shadow-none focus-visible:ring-0 bg-transparent dark:bg-transparent"
              rows={1}
            />
            {busy ? (
              <Button
                size="icon"
                variant="outline"
                className="rounded-full"
                aria-label="Stop"
                onClick={() => void stop()}
              >
                <Square />
              </Button>
            ) : (
              <Button
                size="icon"
                className="rounded-full"
                aria-label="Send"
                disabled={!input.trim() || !hasKey}
                onClick={send}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
          <div className="mt-1 flex items-center">
            <ModelPickerDialog session={session} />
            <SkillsLoaded />
          </div>
        </div>
      </div>
    </div>
  );
}
