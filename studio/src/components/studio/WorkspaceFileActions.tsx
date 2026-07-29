import { useRef, useState } from "react";
import { ArchiveRestore, Download, FolderPlus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { emitFsChanged } from "@/lib/events";
import { sharedFs } from "@/lib/sandbox";
import { DATA_ROOT } from "@/lib/skills";

function NewFolderButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const create = async () => {
    const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    try {
      const fs = await sharedFs();
      await fs.mkdir(`${DATA_ROOT}/${trimmed}`, { recursive: true });
      emitFsChanged();
      setName("");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
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
        <TooltipContent side="top">New folder</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            autoFocus
            placeholder="folder or nested/path"
            value={name}
            onChange={(event) => setName(event.target.value)}
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

export function WorkspaceFileActions() {
  const uploadRef = useRef<HTMLInputElement>(null);
  const tarRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const fs = await sharedFs();
      for (const file of Array.from(files)) {
        await fs.writeFile(
          `${DATA_ROOT}/${file.name}`,
          new Uint8Array(await file.arrayBuffer()),
        );
      }
      emitFsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const importTar = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const fs = await sharedFs();
      await fs.import(new Uint8Array(await file.arrayBuffer()));
      emitFsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const exportTar = async () => {
    try {
      const fs = await sharedFs();
      const bytes = new Uint8Array(await fs.export());
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/x-tar" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "workspace.tar";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ml-auto flex items-center">
      <NewFolderButton />
      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
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
        <TooltipContent side="top">Upload files into /data</TooltipContent>
      </Tooltip>
      <input
        ref={tarRef}
        type="file"
        accept=".tar,application/x-tar"
        hidden
        onChange={(event) => {
          void importTar(event.target.files);
          event.target.value = "";
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Load tar"
              onClick={() => tarRef.current?.click()}
            >
              <ArchiveRestore />
            </Button>
          }
        />
        <TooltipContent side="top">Load tar into workspace</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Export tar"
              onClick={() => void exportTar()}
            >
              <Download />
            </Button>
          }
        />
        <TooltipContent side="top">Export workspace.tar</TooltipContent>
      </Tooltip>
    </div>
  );
}
