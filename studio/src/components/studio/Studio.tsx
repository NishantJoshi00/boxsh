import { useEffect, useState } from "react";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlert } from "lucide-react";
import { initSandbox } from "@/lib/sandbox";
import {
  matchesGlobalHelpShortcut,
  matchesShortcut,
  sessionShortcutIndex,
} from "@/lib/shortcuts";
import { useStudio } from "@/lib/store";
import { AppSidebar } from "./AppSidebar";
import { SessionView } from "./SessionView";
import { TerminalView } from "./TerminalView";
import { FilesView } from "./FilesView";
import { KeysDialog } from "./KeysDialog";
import { EmptyState } from "./EmptyState";
import { SkillsDialog } from "./SkillsDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { BrowserDisclaimerDialog } from "./BrowserDisclaimerDialog";
import { Toaster } from "@/components/ui/sonner";

function FloatingTrigger() {
  const { open, openMobile, isMobile } = useSidebar();
  const visible = isMobile ? !openMobile : !open;
  if (!visible) return null;
  return (
    <SidebarTrigger className="absolute top-2 left-2 z-40 bg-background/80 backdrop-blur border shadow-sm" />
  );
}

function Workspace() {
  const view = useStudio((st) => st.view);
  const sessions = useStudio((st) => st.sessions);
  const active = view.kind === "session"
    ? sessions.find((s) => s.id === view.sessionId)
    : undefined;

  return (
    <main className="relative flex-1 min-w-0 h-svh overflow-hidden">
      <FloatingTrigger />
      {view.kind === "empty" && <EmptyState />}
      {active && <SessionView key={active.id} session={active} />}
      <TerminalView hidden={view.kind !== "terminal"} />
      <FilesView hidden={view.kind !== "files"} />
    </main>
  );
}

export default function Studio() {
  const [engine, setEngine] = useState<"loading" | "ready" | string>("loading");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    initSandbox().then(
      () => setEngine("ready"),
      (err) => setEngine(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesGlobalHelpShortcut(event)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      const target = event.target;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (editable && event.code === "Escape") {
        target.blur();
        return;
      }
      if (editable) return;

      if (matchesShortcut(event, "shortcuts")) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      const studio = useStudio.getState();
      const sessionIndex = sessionShortcutIndex(event);
      const session = sessionIndex === null ? undefined : studio.sessions[sessionIndex];
      if (session) {
        event.preventDefault();
        studio.setView({ kind: "session", sessionId: session.id });
      } else if (matchesShortcut(event, "new-session")) {
        event.preventDefault();
        studio.addSession();
      } else if (matchesShortcut(event, "terminal")) {
        event.preventDefault();
        studio.setView({ kind: "terminal" });
      } else if (matchesShortcut(event, "files")) {
        event.preventDefault();
        studio.setView({ kind: "files" });
      } else if (matchesShortcut(event, "api-keys")) {
        event.preventDefault();
        studio.setKeysOpen(true);
      } else if (matchesShortcut(event, "skills")) {
        event.preventDefault();
        studio.setSkillsOpen(true);
      } else if (
        matchesShortcut(event, "model-picker") &&
        studio.view.kind === "session"
      ) {
        event.preventDefault();
        studio.setModelPickerSessionId(studio.view.sessionId);
      } else if (
        matchesShortcut(event, "composer") &&
        studio.view.kind === "session"
      ) {
        event.preventDefault();
        document.getElementById(`composer-${studio.view.sessionId}`)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (engine === "loading") {
    return (
      <Empty className="h-svh">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading sandbox engine</EmptyTitle>
          <EmptyDescription>Compiling WebAssembly command modules…</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (engine !== "ready") {
    return (
      <div className="h-svh grid place-items-center p-6">
        <Alert variant="destructive" className="max-w-lg">
          <CircleAlert />
          <AlertTitle>The sandbox engine failed to load</AlertTitle>
          <AlertDescription>{engine}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <Workspace />
      <KeysDialog />
      <SkillsDialog />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <BrowserDisclaimerDialog />
      <Toaster />
    </SidebarProvider>
  );
}
