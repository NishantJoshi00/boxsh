import { useRef, useState } from "react";
import { ArrowDownUp, ArrowLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { emitFsChanged } from "@/lib/events";
import { useStudio, type BackendKind } from "@/lib/store";
import { exportSandboxArchive, importSandboxArchive } from "@/lib/transfer";
import { BACKENDS, BackendChoice } from "./BackendPickerDialog";

/** Export/import the whole sandbox (workspace.tar + open sessions) as a zip. */
export function TransferDialog() {
  const sandboxName = useStudio((st) => st.sandboxName);
  const [open, setOpen] = useState(false);
  const [archive, setArchive] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const changeOpen = (nextOpen: boolean) => {
    if (busy) return;
    setOpen(nextOpen);
    if (nextOpen) setArchive(null);
  };

  const exportZip = async () => {
    if (busy) return;
    setBusy("export");
    try {
      const blob = await exportSandboxArchive();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sandboxName.replace(/[^\w.-]+/g, "-") || "sandbox"}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pickArchive = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setArchive(new Uint8Array(await file.arrayBuffer()));
  };

  const importZip = async (kind: BackendKind) => {
    if (!archive || busy) return;
    setBusy(kind);
    try {
      await importSandboxArchive(archive, kind);
      emitFsChanged();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Export or import sandbox"
              onClick={() => changeOpen(true)}
            />
          }
        >
          <ArrowDownUp />
        </TooltipTrigger>
        <TooltipContent side="top">Export or import sandbox</TooltipContent>
      </Tooltip>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          void pickArchive(event.target.files);
          event.target.value = "";
        }}
      />

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-2">
              {archive && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 -mt-1 shrink-0"
                  aria-label="Back"
                  disabled={Boolean(busy)}
                  onClick={() => setArchive(null)}
                >
                  <ArrowLeft />
                </Button>
              )}
              <div className="grid gap-1">
                <DialogTitle>
                  {archive ? "Choose storage" : "Export or import"}
                </DialogTitle>
                <DialogDescription>
                  {archive
                    ? "Choose where the imported sandbox should live."
                    : "Move a whole sandbox — files and open sessions — as one zip."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {archive && busy ? (
            <div className="grid place-items-center py-10">
              <Spinner />
            </div>
          ) : archive ? (
            <div className="grid grid-cols-3 justify-items-center gap-6 py-7">
              {BACKENDS.map((option) => (
                <BackendChoice
                  key={option.kind}
                  option={option}
                  onSelect={(kind) => void importZip(kind)}
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-1 py-2">
              <Button
                type="button"
                variant="ghost"
                className="h-auto justify-start px-2 py-2.5 text-left"
                disabled={Boolean(busy)}
                onClick={() => void exportZip()}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span>Export this sandbox</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Download {sandboxName} with its files and sessions.
                  </span>
                </span>
                {busy === "export" ? <Spinner /> : <ChevronRight />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-auto justify-start px-2 py-2.5 text-left"
                disabled={Boolean(busy)}
                onClick={() => fileRef.current?.click()}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span>Import a sandbox</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Load an exported zip as a new sandbox.
                  </span>
                </span>
                <ChevronRight />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
