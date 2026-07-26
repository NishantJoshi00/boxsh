import { useMemo, useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { emitFsChanged } from "@/lib/events";
import { sharedFs } from "@/lib/sandbox";
import {
  SkillImportError,
  discoverGitHubSkills,
  installSkills,
  type SkillImportPreview,
  type SkillInstallProgress,
} from "@/lib/skills";
import { useStudio } from "@/lib/store";
import { cn } from "@/lib/utils";

const TOAST_ID = "skill-install";

function SkillProgress({
  progress,
  onReview,
}: {
  progress: SkillInstallProgress;
  onReview: () => void;
}) {
  const percent =
    progress.phase === "installing"
      ? Math.max(4, (progress.current / progress.total) * 100)
      : progress.phase === "found"
        ? 3
        : 0;
  return (
    <div
      className={cn("skill-toast", progress.phase === "error" && "skill-toast-error")}
      role={progress.phase === "error" ? "alert" : "status"}
      aria-live={progress.phase === "error" ? "assertive" : "polite"}
    >
      <div className="flex items-center gap-2.5">
        {progress.phase === "error" ? (
          <CircleAlert className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="skill-toast-orb" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{progress.message}</span>
        {progress.phase === "error" && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onReview}
          >
            Review
          </button>
        )}
      </div>
      {progress.phase === "installing" && (
        <div className="mt-2 h-px overflow-hidden bg-white/8" aria-hidden="true">
          <div className="skill-toast-progress" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SkillsDialog() {
  const open = useStudio((state) => state.skillsOpen);
  const setOpen = useStudio((state) => state.setSkillsOpen);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const selectedCandidates = useMemo(
    () => preview?.candidates.filter((candidate) => selected.has(candidate.id)) ?? [],
    [preview, selected],
  );
  const replacements = selectedCandidates.filter((candidate) => candidate.replacing);

  const showProgress = (progress: SkillInstallProgress) => {
    toast.custom(
      () => (
        <SkillProgress
          progress={progress}
          onReview={() => {
            setOpen(true);
          }}
        />
      ),
      { id: TOAST_ID, duration: Number.POSITIVE_INFINITY },
    );
  };

  const reset = () => {
    setPreview(null);
    setSelected(new Set());
    setError(null);
    setConfirming(false);
  };

  const changeOpen = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next && !error) toast.dismiss(TOAST_ID);
  };

  const discover = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setConfirming(false);
    showProgress({ phase: "checking", message: "Checking repository" });
    try {
      const result = await discoverGitHubSkills(trimmed, { fs: await sharedFs() });
      setPreview(result);
      setSelected(
        new Set(
          result.candidates
            .filter((candidate) => candidate.valid && candidate.selected)
            .map((candidate) => candidate.id),
        ),
      );
      showProgress({
        phase: "found",
        message: `Found ${result.candidates.length} ${result.candidates.length === 1 ? "skill" : "skills"}`,
        count: result.candidates.length,
      });
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      showProgress({ phase: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const beginInstall = async (confirmed: boolean) => {
    if (!preview || selected.size === 0) return;
    if (replacements.length > 0 && !confirmed) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    setOpen(false);
    try {
      await installSkills({
        fs: await sharedFs(),
        preview,
        selectedIds: [...selected],
        confirmReplacements: confirmed,
        onProgress: showProgress,
        onMutate: emitFsChanged,
      });
      toast.dismiss(TOAST_ID);
      setPreview(null);
      setSelected(new Set());
      setConfirming(false);
    } catch (caught) {
      const message =
        caught instanceof SkillImportError && caught.issues.length > 0
          ? `${caught.message}: ${caught.issues[0]?.message}`
          : errorMessage(caught);
      setError(message);
      showProgress({ phase: "error", message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add skills</DialogTitle>
          <DialogDescription>
            Import Agent Skills from a public GitHub repository or folder.
          </DialogDescription>
        </DialogHeader>

        {confirming ? (
          <div className="grid gap-2 py-1">
            <p className="text-sm">
              Replace {replacements.map((candidate) => candidate.metadata?.name).join(", ")}?
            </p>
            <p className="text-xs text-muted-foreground">
              Existing versions are restored if any selected skill fails to install.
            </p>
          </div>
        ) : (
          <>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void discover();
              }}
            >
              <Input
                autoFocus
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (preview || error) reset();
                }}
                placeholder="https://github.com/owner/repo"
                aria-label="Public GitHub URL"
              />
              <Button type="submit" variant="secondary" disabled={!url.trim() || busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : "Check"}
              </Button>
            </form>

            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}

            {preview && preview.candidates.some((candidate) => candidate.valid) && (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() =>
                    setSelected(
                      new Set(
                        preview.candidates
                          .filter((candidate) => candidate.valid)
                          .map((candidate) => candidate.id),
                      ),
                    )
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => setSelected(new Set())}
                >
                  Deselect all
                </Button>
              </div>
            )}

            {preview && (
              <div className="grid max-h-72 gap-0.5 overflow-y-auto py-1">
                {preview.candidates.length === 0 && (
                  <p className="py-2 text-xs text-muted-foreground">
                    No SKILL.md files found under this path.
                  </p>
                )}
                {preview.candidates.map((candidate, index) => {
                  const disabled = !candidate.valid;
                  const reason = candidate.issues[0]?.message;
                  const checkboxId = `skill-candidate-${index}`;
                  return (
                    <div
                      key={candidate.id}
                      className={cn(
                        "flex items-start gap-2 rounded-md px-1.5 py-1.5 text-sm",
                        disabled
                          ? "cursor-not-allowed text-muted-foreground/60"
                          : "cursor-pointer hover:bg-muted/50",
                      )}
                    >
                      <Checkbox
                        id={checkboxId}
                        className="mt-0.5"
                        checked={selected.has(candidate.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) => {
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(candidate.id);
                            else next.delete(candidate.id);
                            return next;
                          });
                        }}
                      />
                      <Label
                        htmlFor={checkboxId}
                        className={cn(
                          "min-w-0 flex-1 cursor-pointer items-start font-normal leading-normal",
                          disabled && "cursor-not-allowed",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">
                              {candidate.metadata?.name ?? candidate.sourceDirectory}
                            </span>
                            {candidate.replacing && (
                              <span className="text-[11px] text-muted-foreground">
                                replaces existing
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {reason ?? candidate.metadata?.description}
                          </span>
                        </span>
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {confirming && (
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Back
            </Button>
          )}
          <Button
            onClick={() => void beginInstall(confirming)}
            disabled={!preview || selected.size === 0 || busy}
          >
            {confirming
              ? "Replace and install"
              : selected.size > 0
                ? `Install ${selected.size}`
                : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
