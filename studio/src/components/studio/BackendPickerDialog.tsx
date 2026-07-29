import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ChevronRight,
  Database,
  HardDrive,
  MemoryStick,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { emitFsChanged } from "@/lib/events";
import {
  openWorkspaceSandbox,
  switchWorkspaceBackend,
  trashWorkspaceSandbox,
  type BackendSwitchMode,
} from "@/lib/sandbox";
import {
  useStudio,
  type BackendKind,
  type SavedSandbox,
} from "@/lib/store";

export interface BackendOption {
  kind: BackendKind;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const BACKENDS: BackendOption[] = [
  {
    kind: "memory",
    label: "In-memory",
    description: "Fast and temporary. Cleared when this tab closes.",
    icon: MemoryStick,
  },
  {
    kind: "indexeddb",
    label: "IndexedDB",
    description: "Persistent browser storage that survives reloads.",
    icon: Database,
  },
  {
    kind: "opfs",
    label: "OPFS",
    description: "Browser-native persistent storage for larger workspaces.",
    icon: HardDrive,
  },
];

export const backendOption = (kind: BackendKind) =>
  BACKENDS.find((option) => option.kind === kind) ?? BACKENDS[0];

const sandboxKey = (
  sandbox: Pick<SavedSandbox, "id" | "backendKind">,
) => `${sandbox.backendKind}:${sandbox.id}`;

export function BackendChoice({
  option,
  onSelect,
}: {
  option: BackendOption;
  onSelect: (kind: BackendKind) => void;
}) {
  const Icon = option.icon;
  return (
    <div className="grid justify-items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="size-16 rounded-full p-0"
              aria-label={`Create ${option.label} sandbox`}
              onClick={() => onSelect(option.kind)}
            />
          }
        >
          <Icon className="size-6" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-52 text-center">
          {option.description}
        </TooltipContent>
      </Tooltip>
      <span className="text-sm text-muted-foreground">{option.label}</span>
    </div>
  );
}

function lastOpenedLabel(timestamp: number): string {
  if (!timestamp) return "Found in this browser";
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "Opened just now";
  if (elapsed < 3_600_000) {
    return `Opened ${Math.floor(elapsed / 60_000)}m ago`;
  }
  if (elapsed < 86_400_000) {
    return `Opened ${Math.floor(elapsed / 3_600_000)}h ago`;
  }
  return `Opened ${Math.floor(elapsed / 86_400_000)}d ago`;
}

function SandboxRow({
  sandbox,
  current,
  loading,
  onOpen,
  onTrash,
}: {
  sandbox: SavedSandbox;
  current?: boolean;
  loading?: boolean;
  onOpen?: () => void;
  onTrash: () => void;
}) {
  const option = backendOption(sandbox.backendKind);
  const Icon = option.icon;
  return (
    <div className="group/sandbox relative">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start px-2 py-2 pr-16 text-left"
        aria-current={current ? "true" : undefined}
        disabled={loading}
        onClick={onOpen}
      >
        <Icon className="size-4 text-muted-foreground" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate">{sandbox.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {option.label} · {current ? "Current" : lastOpenedLabel(sandbox.lastOpenedAt)}
          </span>
        </span>
      </Button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
        {loading ? (
          <Spinner className="mr-2 size-4" />
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="opacity-0 group-hover/sandbox:opacity-100 group-focus-within/sandbox:opacity-100"
              aria-label={`Trash ${sandbox.name}`}
              onClick={onTrash}
            >
              <Trash2 />
            </Button>
            {!current && <ChevronRight className="mr-1 size-4 text-muted-foreground" />}
          </>
        )}
      </div>
    </div>
  );
}

export function BackendPickerDialog() {
  const sandboxId = useStudio((st) => st.sandboxId);
  const sandboxName = useStudio((st) => st.sandboxName);
  const kind = useStudio((st) => st.backendKind);
  const savedSandboxes = useStudio((st) => st.savedSandboxes);
  const [open, setOpen] = useState(false);
  const [choosingBackend, setChoosingBackend] = useState(false);
  const [target, setTarget] = useState<BackendKind | null>(null);
  const [trashTarget, setTrashTarget] = useState<SavedSandbox | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const currentOption = backendOption(kind);
  const CurrentIcon = currentOption.icon;
  const next = target ? backendOption(target) : undefined;
  const currentKey = `${kind}:${sandboxId}`;
  const saved = [...savedSandboxes].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt,
  );
  const currentSaved =
    kind === "memory"
      ? undefined
      : saved.find((sandbox) => sandboxKey(sandbox) === currentKey);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSaved = saved
    .filter((sandbox) => sandboxKey(sandbox) !== currentKey)
    .filter((sandbox) => {
      if (!normalizedQuery) return true;
      const storage = backendOption(sandbox.backendKind).label;
      return `${sandbox.name} ${sandbox.id} ${storage}`
        .toLowerCase()
        .includes(normalizedQuery);
    });

  const reset = () => {
    setChoosingBackend(false);
    setTarget(null);
    setTrashTarget(null);
    setQuery("");
  };

  const changeOpen = (nextOpen: boolean) => {
    if (busy) return;
    setOpen(nextOpen);
    if (nextOpen) reset();
  };

  const performSwitch = async (mode: BackendSwitchMode) => {
    if (!target || busy) return;
    setBusy(mode);
    try {
      await switchWorkspaceBackend(target, mode);
      emitFsChanged();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadSandbox = async (sandbox: SavedSandbox) => {
    if (busy) return;
    setBusy(sandboxKey(sandbox));
    try {
      await openWorkspaceSandbox(sandbox);
      emitFsChanged();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const trashSandbox = async () => {
    if (!trashTarget || busy) return;
    setBusy(`trash:${sandboxKey(trashTarget)}`);
    try {
      await trashWorkspaceSandbox(trashTarget);
      emitFsChanged();
      setTrashTarget(null);
      if (
        trashTarget.id === sandboxId &&
        trashTarget.backendKind === kind
      ) {
        setOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const goBack = () => {
    if (trashTarget) {
      setTrashTarget(null);
    } else if (target) {
      setTarget(null);
    } else {
      setChoosingBackend(false);
    }
  };

  const hasBack = choosingBackend || Boolean(target) || Boolean(trashTarget);
  const title = trashTarget
    ? `Trash ${trashTarget.name}?`
    : next
      ? `Create in ${next.label}`
      : choosingBackend
        ? "Choose storage"
        : "Sandboxes";
  const description = trashTarget
    ? "Its files will be permanently removed from this browser."
    : next
      ? `What should happen to ${sandboxName}?`
      : choosingBackend
        ? "Choose where the new sandbox should live."
        : "Open a saved sandbox or create another.";

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-ml-1 shrink-0 text-muted-foreground"
              aria-label={`Sandbox storage: ${currentOption.label}`}
              onClick={() => changeOpen(true)}
            />
          }
        >
          <CurrentIcon />
        </TooltipTrigger>
        <TooltipContent side="right">{currentOption.label}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-2">
              {hasBack && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 -mt-1 shrink-0"
                  aria-label="Back"
                  disabled={Boolean(busy)}
                  onClick={goBack}
                >
                  <ArrowLeft />
                </Button>
              )}
              <div className="grid gap-1">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {trashTarget ? (
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => setTrashTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() => void trashSandbox()}
              >
                {busy ? <Spinner /> : <Trash2 />}
                Trash sandbox
              </Button>
            </div>
          ) : next ? (
            <div className="grid gap-1 py-2">
              {target !== kind && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto justify-start px-2 py-2.5 text-left"
                  disabled={Boolean(busy)}
                  onClick={() => void performSwitch("migrate")}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span>Migrate current sandbox</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Copy the current files into {next.label}.
                    </span>
                  </span>
                  {busy === "migrate" ? <Spinner /> : <ChevronRight />}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="h-auto justify-start px-2 py-2.5 text-left"
                disabled={Boolean(busy)}
                onClick={() => void performSwitch("abandon")}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span>Start fresh</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Leave the current sandbox available if it is persistent.
                  </span>
                </span>
                {busy === "abandon" ? <Spinner /> : <ChevronRight />}
              </Button>
            </div>
          ) : choosingBackend ? (
            <div className="grid grid-cols-3 justify-items-center gap-6 py-7">
              {BACKENDS.map((option) => (
                <BackendChoice
                  key={option.kind}
                  option={option}
                  onSelect={setTarget}
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-1 py-1">
              {kind === "memory" ? (
                <div className="flex items-center gap-1.5 px-2 py-2">
                  <MemoryStick className="size-4 text-muted-foreground" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-medium">{sandboxName}</span>
                    <span className="text-xs text-muted-foreground">
                      In-memory · Current
                    </span>
                  </span>
                </div>
              ) : currentSaved ? (
                <SandboxRow
                  sandbox={currentSaved}
                  current
                  onTrash={() => setTrashTarget(currentSaved)}
                />
              ) : null}

              {saved.length > (currentSaved ? 1 : 0) && (
                <div className="relative my-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search sandboxes"
                    aria-label="Search sandboxes"
                    className="pl-8"
                  />
                </div>
              )}

              {filteredSaved.length > 5 ? (
                <ScrollArea className="h-64">
                  <div className="grid gap-1 pr-3">
                    {filteredSaved.map((sandbox) => (
                      <SandboxRow
                        key={sandboxKey(sandbox)}
                        sandbox={sandbox}
                        loading={busy === sandboxKey(sandbox)}
                        onOpen={() => void loadSandbox(sandbox)}
                        onTrash={() => setTrashTarget(sandbox)}
                      />
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                filteredSaved.map((sandbox) => (
                  <SandboxRow
                    key={sandboxKey(sandbox)}
                    sandbox={sandbox}
                    loading={busy === sandboxKey(sandbox)}
                    onOpen={() => void loadSandbox(sandbox)}
                    onTrash={() => setTrashTarget(sandbox)}
                  />
                ))
              )}

              {normalizedQuery && filteredSaved.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No matching sandboxes.
                </p>
              )}

              <Button
                type="button"
                variant="ghost"
                className="mt-1 justify-start text-muted-foreground"
                onClick={() => setChoosingBackend(true)}
              >
                <Plus />
                New sandbox
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
