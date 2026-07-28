import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { DirEntry } from "@boxsh/sandbox";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  File,
  FileX,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { sharedFs } from "@/lib/sandbox";
import { onFsChanged } from "@/lib/events";
import { cn } from "@/lib/utils";

const PREVIEW_LIMIT = 512 * 1024;
/** Above this, skip Shiki and show plain text — highlighting gets slow. */
const HIGHLIGHT_LIMIT = 100 * 1024;

const plugins = { code };
const noControls = { code: false, table: false } as const;

const LANG_BY_EXT: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  sh: "bash",
  bash: "bash",
  py: "python",
  yml: "yaml",
  yaml: "yaml",
  astro: "astro",
  c: "c",
  h: "c",
  cpp: "cpp",
  go: "go",
  sql: "sql",
  xml: "xml",
  txt: "text",
};

function langFor(path: string): string {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  return LANG_BY_EXT[ext] ?? (ext || "text");
}

/** Wrap file content in a fence longer than any backtick run it contains. */
function fenced(content: string, lang: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function DirRow({
  entry,
  path,
  depth,
  version,
  selected,
  onSelect,
}: {
  entry: DirEntry;
  path: string;
  depth: number;
  version: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isDir = entry.kind === "dir";
  const rowClassName = cn(
    "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-left hover:bg-accent/50",
    selected === path && "bg-accent text-accent-foreground",
  );
  const rowStyle = { paddingLeft: `${depth * 14 + 8}px` };

  if (!isDir) {
    return (
      <button
        type="button"
        className={rowClassName}
        style={rowStyle}
        onClick={() => onSelect(path)}
      >
        <File className="size-4 shrink-0 text-muted-foreground ml-[1.125rem]" />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={rowClassName} style={rowStyle}>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {open ? (
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{entry.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <DirChildren
          path={path}
          depth={depth + 1}
          version={version}
          selected={selected}
          onSelect={onSelect}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function DirChildren(props: {
  path: string;
  depth: number;
  version: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void sharedFs()
      .then((fs) => fs.readdir(props.path || "/"))
      .then((es) => {
        if (alive) setEntries(es);
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, [props.path, props.version]);

  return (
    <>
      {entries.map((e) => (
        <DirRow
          key={`${props.path}/${e.name}`}
          entry={e}
          path={`${props.path}/${e.name}`}
          depth={props.depth}
          version={props.version}
          selected={props.selected}
          onSelect={props.onSelect}
        />
      ))}
      {props.depth === 0 && entries.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No files yet.</p>
      )}
    </>
  );
}

type Preview =
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "binary"; size: number }
  | { kind: "text"; content: string; size: number; truncated: boolean };

export function FilesView({ hidden }: { hidden: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<Preview>({ kind: "none" });

  useEffect(() => onFsChanged(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!selected) {
      setPreview({ kind: "none" });
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const fs = await sharedFs();
        const bytes = await fs.readFile(selected);
        const head = bytes.subarray(0, 8192);
        if (head.includes(0)) {
          if (alive) setPreview({ kind: "binary", size: bytes.length });
          return;
        }
        const slice = bytes.subarray(0, PREVIEW_LIMIT);
        const content = new TextDecoder().decode(slice);
        if (alive) {
          setPreview({
            kind: "text",
            content,
            size: bytes.length,
            truncated: bytes.length > PREVIEW_LIMIT,
          });
        }
      } catch {
        if (alive) {
          setPreview({ kind: "missing" });
          setSelected(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, version]);

  return (
    <div className={cn("h-full", hidden && "hidden")}>
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="30" minSize="18">
          <div className="flex h-full flex-col">
            <div className="flex items-center border-b px-3 py-2 pl-12">
              <span className="text-sm font-medium">Files</span>
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-1.5">
                <DirChildren
                  path=""
                  depth={0}
                  version={version}
                  selected={selected}
                  onSelect={setSelected}
                />
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="70">
          {preview.kind === "none" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <File />
                </EmptyMedia>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>
                  Pick a file from the tree to preview it.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : preview.kind === "binary" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileX />
                </EmptyMedia>
                <EmptyTitle>Binary file</EmptyTitle>
                <EmptyDescription>
                  {selected} · {formatSize(preview.size)}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : preview.kind === "text" ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className="truncate font-mono text-xs">{selected}</span>
                <Badge variant="secondary" className="ml-auto shrink-0">
                  {formatSize(preview.size)}
                </Badge>
              </div>
              <ScrollArea className="flex-1 min-h-0">
                {preview.content.length > HIGHLIGHT_LIMIT ? (
                  <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
                    {preview.content}
                  </pre>
                ) : (
                  <Streamdown
                    plugins={plugins}
                    mode="static"
                    controls={noControls}
                    className="p-3 text-sm [&_pre]:whitespace-pre-wrap"
                  >
                    {fenced(preview.content, langFor(selected ?? ""))}
                  </Streamdown>
                )}
                {preview.truncated && (
                  <p className="px-3 pb-3 text-xs text-muted-foreground">… preview truncated</p>
                )}
              </ScrollArea>
            </div>
          ) : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
