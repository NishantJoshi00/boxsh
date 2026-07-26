import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { sessionShortcutKeys, SHORTCUTS } from "@/lib/shortcuts";
import { useStudio } from "@/lib/store";

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sessions = useStudio((state) => state.sessions).slice(0, 9);
  const rows = [
    ...sessions.map((session, index) => ({
      id: session.id,
      label: session.title,
      keys: sessionShortcutKeys(index),
    })),
    ...SHORTCUTS,
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work when you’re not typing. Press Esc to leave an input.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] divide-y divide-border/60 overflow-y-auto pr-1">
          {rows.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span className="text-muted-foreground">{item.label}</span>
              <KbdGroup>
                {item.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
