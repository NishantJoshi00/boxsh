import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUp, Brain, ChevronRight, CircleAlert, KeyRound, Square } from "lucide-react";
import { chatFor } from "@/lib/agent/chats";
import { PROVIDER_LABELS, listModels } from "@/lib/models";
import { useStudio, type AgentSession } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ToolCard } from "./ToolCard";

function ModelPicker({ session }: { session: AgentSession }) {
  const key = useStudio((st) => st.keys[session.provider]);
  const setSessionModel = useStudio((st) => st.setSessionModel);
  const [models, setModels] = useState<string[] | null>(null);

  useEffect(() => {
    if (!key) {
      setModels(null);
      return;
    }
    let alive = true;
    listModels(session.provider, key)
      .then((ms) => alive && setModels(ms))
      .catch(() => alive && setModels(null));
    return () => {
      alive = false;
    };
  }, [session.provider, key]);

  const options = models?.includes(session.model)
    ? models
    : [session.model, ...(models ?? [])];

  return (
    <Select
      value={session.model}
      onValueChange={(v) => v && setSessionModel(session.id, v)}
    >
      <SelectTrigger
        size="sm"
        className="h-7 gap-1 border-0 bg-transparent dark:bg-transparent shadow-none text-xs text-muted-foreground hover:text-foreground"
        aria-label="Model"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const plugins = { code };

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
        <Streamdown plugins={plugins} isAnimating={streaming}>
          {text}
        </Streamdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SessionView({ session }: { session: AgentSession }) {
  const chat = useMemo(
    () => chatFor(session.id, session.provider),
    [session.id, session.provider],
  );
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
                m.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <Streamdown
                        key={i}
                        plugins={plugins}
                        isAnimating={part.state === "streaming"}
                        className="text-sm"
                      >
                        {part.text}
                      </Streamdown>
                    );
                  }
                  if (part.type === "reasoning") {
                    return part.text.trim() ? (
                      <Reasoning key={i} text={part.text} streaming={part.state === "streaming"} />
                    ) : null;
                  }
                  if (part.type.startsWith("tool-")) {
                    return <ToolCard key={i} part={part as never} />;
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

      <div className="border-t bg-background">
        <div className="mx-auto max-w-3xl p-3">
          <div className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:ring-2 focus-within:ring-ring">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Message ${PROVIDER_LABELS[session.provider]}…`}
              className="min-h-9 max-h-48 resize-none border-0 shadow-none focus-visible:ring-0 bg-transparent dark:bg-transparent"
              rows={1}
            />
            {busy ? (
              <Button size="icon" variant="outline" aria-label="Stop" onClick={() => void stop()}>
                <Square />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label="Send"
                disabled={!input.trim() || !hasKey}
                onClick={send}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <ModelPicker session={session} />
            <p className="text-[11px] text-muted-foreground">
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
