import { useEffect, useRef, useState } from "react";
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
  FolderPlus,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sharedFs } from "@/lib/sandbox";
import { emitFsChanged, onFsChanged } from "@/lib/events";
import { cn } from "@/lib/utils";
import { DATA_ROOT } from "@/lib/skills";

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

  return (
    <>
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-left hover:bg-accent/50",
          selected === path && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => (isDir ? setOpen((o) => !o) : onSelect(path))}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
            {open ? (
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-4 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <File className="size-4 shrink-0 text-muted-foreground ml-[1.125rem]" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {isDir && open && (
        <DirChildren
          path={path}
          depth={depth + 1}
          version={version}
          selected={selected}
          onSelect={onSelect}
        />
      )}
    </>
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

function NewFolderButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const create = async () => {
    const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    const fs = await sharedFs();
    await fs.mkdir(`${DATA_ROOT}/${trimmed}`, { recursive: true });
    emitFsChanged();
    setName("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="New folder">
                  <FolderPlus />
                </Button>
              }
            />
          }
        />
        <TooltipContent>New folder</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            autoFocus
            placeholder="folder or nested/path"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Create
          </Button>
        </form>
      </PopoverContent>
    </Popover>
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
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => onFsChanged(() => setVersion((v) => v + 1)), []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fs = await sharedFs();
    for (const f of Array.from(files)) {
      await fs.writeFile(`${DATA_ROOT}/${f.name}`, new Uint8Array(await f.arrayBuffer()));
    }
    emitFsChanged();
  };

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
            <div className="flex items-center justify-between border-b px-3 py-2 pl-12">
              <span className="text-sm font-medium">Files</span>
              <div className="flex items-center">
                <NewFolderButton />
                <input
                  ref={uploadRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Upload files"
                        onClick={() => uploadRef.current?.click()}
                      >
                        <Upload />
                      </Button>
                    }
                  />
                  <TooltipContent>Upload files into /data</TooltipContent>
                </Tooltip>
              </div>
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
