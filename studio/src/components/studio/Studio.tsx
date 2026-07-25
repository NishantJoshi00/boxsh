import { useEffect, useState } from "react";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlert } from "lucide-react";
import { initSandbox } from "@/lib/sandbox";
import { useStudio } from "@/lib/store";
import { AppSidebar } from "./AppSidebar";
import { SessionView } from "./SessionView";
import { TerminalView } from "./TerminalView";
import { FilesView } from "./FilesView";
import { KeysDialog } from "./KeysDialog";
import { EmptyState } from "./EmptyState";
import { SkillsDialog } from "./SkillsDialog";
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

  useEffect(() => {
    initSandbox().then(
      () => setEngine("ready"),
      (err) => setEngine(err instanceof Error ? err.message : String(err)),
    );
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
      <Toaster />
    </SidebarProvider>
  );
}
