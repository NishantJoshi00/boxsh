import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";
import { createSession } from "@/lib/sandbox";
import { emitFsChanged } from "@/lib/events";
import { trackCommand } from "@/lib/telemetry";
import { cn } from "@/lib/utils";

interface TermInstance {
  id: number;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
}

/** Lives outside React so terminals survive view switches and tab changes. */
const instances = new Map<number, TermInstance>();
const exitListeners = new Set<(id: number) => void>();
let nextTermId = 1;

function startRepl(term: Terminal, onExit: () => void) {
  const sessionReady = createSession();
  let buf = "";
  let running = false;

  const prompt = async () => {
    const s = await sessionReady;
    term.write(`\x1b[36m${s.cwd}\x1b[0m \x1b[90m$\x1b[0m `);
  };

  const run = async () => {
    const script = buf;
    buf = "";
    if (script.trim() === "exit") {
      term.write("\r\n");
      onExit();
      return;
    }
    running = true;
    term.write("\r\n");
    if (script.trim() === "clear") {
      term.write("\x1b[2J\x1b[3J\x1b[H");
      running = false;
      await prompt();
      return;
    }
    if (script.trim()) {
      try {
        const s = await sessionReady;
        const r = await s.exec(script);
        trackCommand({
          source: "terminal",
          script,
          exitCode: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
        });
        if (r.stdout) term.write(r.stdout);
        if (r.stdout && !r.stdout.endsWith("\n")) term.write("\r\n");
        if (r.stderr) term.write(`\x1b[31m${r.stderr}\x1b[0m`);
        if (r.stderr && !r.stderr.endsWith("\n")) term.write("\r\n");
        emitFsChanged();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trackCommand({
          source: "terminal",
          script,
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: msg,
        });
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`);
      }
    }
    running = false;
    await prompt();
  };

  void prompt();

  term.onData((data) => {
    if (running) return;
    const chars = data.replace(/\r\n/g, "\r");
    for (const ch of chars) {
      if (ch === "\r" || ch === "\n") {
        void run();
      } else if (ch === "\x7f") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          term.write("\b \b");
        }
      } else if (ch === "\x03") {
        buf = "";
        term.write("^C\r\n");
        void prompt();
      } else if (ch === "\x0c") {
        const pending = buf;
        term.write("\x1b[2J\x1b[3J\x1b[H");
        void prompt().then(() => term.write(pending));
      } else if (ch >= " " || ch === "\t") {
        buf += ch;
        term.write(ch);
      }
    }
  });
}

function getInstance(id: number): TermInstance {
  let inst = instances.get(id);
  if (!inst) {
    const container = document.createElement("div");
    container.className = "h-full w-full";
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#00000000",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3f3f46",
      },
      allowTransparency: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    startRepl(term, () => exitListeners.forEach((l) => l(id)));
    inst = { id, container, term, fit };
    instances.set(id, inst);
  }
  return inst;
}

function TermMount({ id, active }: { id: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const inst = getInstance(id);
    host.appendChild(inst.container);
    return () => {
      if (inst.container.parentElement === host) host.removeChild(inst.container);
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    const inst = getInstance(id);
    const refit = () => {
      if (inst.container.clientWidth > 0) inst.fit.fit();
    };
    refit();
    inst.term.focus();
    const ro = new ResizeObserver(refit);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [id, active]);

  return <div ref={ref} className={cn("h-full w-full p-2", !active && "hidden")} />;
}

export function TerminalView({ hidden }: { hidden: boolean }) {
  const [terms, setTerms] = useState<number[]>([]);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    if (terms.length === 0) {
      const id = nextTermId++;
      setTerms([id]);
      setActive(id);
    }
  }, [terms.length]);

  const addTerm = () => {
    const id = nextTermId++;
    setTerms((t) => [...t, id]);
    setActive(id);
  };

  const closeTerm = (id: number) => {
    const inst = instances.get(id);
    if (inst) {
      inst.term.dispose();
      instances.delete(id);
    }
    setTerms((t) => {
      const next = t.filter((x) => x !== id);
      setActive((a) => (a === id ? (next[next.length - 1] ?? null) : a));
      return next;
    });
  };

  // The `exit` shell command closes its terminal.
  useEffect(() => {
    exitListeners.add(closeTerm);
    return () => {
      exitListeners.delete(closeTerm);
    };
  }, []);

  return (
    <div className={cn("flex h-full flex-col", hidden && "hidden")}>
      <div className="flex items-center gap-1 border-b px-2 py-1.5 pl-12">
        {terms.map((id, i) => (
          <div
            key={id}
            className={cn(
              "group flex items-center gap-1 rounded-md border px-2 py-1 text-xs cursor-pointer select-none",
              active === id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => setActive(id)}
          >
            Terminal {i + 1}
            <button
              aria-label="Close terminal"
              className="opacity-50 hover:opacity-100 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                closeTerm(id);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="icon-sm" aria-label="New terminal" onClick={addTerm}>
          <Plus />
        </Button>
      </div>
      <div className="flex-1 min-h-0 bg-background">
        {terms.map((id) => (
          <TermMount key={id} id={id} active={!hidden && active === id} />
        ))}
      </div>
    </div>
  );
}
