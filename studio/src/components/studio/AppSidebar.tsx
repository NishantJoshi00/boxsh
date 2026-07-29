import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Bot,
  Folder,
  KeyRound,
  PackagePlus,
  Plus,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { Spinner } from "@/components/ui/spinner";
import { useStudio, type AgentSession } from "@/lib/store";
import { sessionShortcutKeys, shortcut } from "@/lib/shortcuts";
import { chatFor, disposeChat } from "@/lib/agent/chats";
import { BackendPickerDialog } from "./BackendPickerDialog";
import { TransferDialog } from "./TransferDialog";

/** Provider icon that turns into a spinner while the session's agent runs. */
function SessionIcon({ session }: { session: AgentSession }) {
  const { status } = useChat({
    chat: chatFor(session.id),
    throttle: 250,
  });
  if (status === "submitted" || status === "streaming") {
    return <Spinner className="size-4" />;
  }
  return session.provider === "anthropic" ? <Sparkles /> : <Bot />;
}

function SandboxName() {
  const name = useStudio((st) => st.sandboxName);
  const setName = useStudio((st) => st.setSandboxName);
  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      spellCheck={false}
      aria-label="Sandbox name"
      className="w-full min-w-0 bg-transparent font-semibold text-sm outline-none rounded-md px-1 py-0.5 focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

export function AppSidebar() {
  const sessions = useStudio((st) => st.sessions);
  const view = useStudio((st) => st.view);
  const addSession = useStudio((st) => st.addSession);
  const removeSession = useStudio((st) => st.removeSession);
  const setView = useStudio((st) => st.setView);
  const setKeysOpen = useStudio((st) => st.setKeysOpen);
  const setSkillsOpen = useStudio((st) => st.setSkillsOpen);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1">
          <BackendPickerDialog />
          <SandboxName />
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupAction title="New session" onClick={() => addSession()}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {sessions.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No sessions yet.
                </p>
              )}
              {sessions.map((s, index) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton
                    isActive={view.kind === "session" && view.sessionId === s.id}
                    onClick={() => setView({ kind: "session", sessionId: s.id })}
                  >
                    <SessionIcon session={s} />
                    <span className="truncate">{s.title}</span>
                    {index < 9 && (
                      <Kbd className="ml-auto h-4 min-w-0 bg-transparent px-0 text-[10px] opacity-60 group-data-[collapsible=icon]:hidden">
                        {sessionShortcutKeys(index).join(" ")}
                      </Kbd>
                    )}
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    showOnHover
                    aria-label="Close session"
                    onClick={() => {
                      disposeChat(s.id);
                      removeSession(s.id);
                    }}
                  >
                    <X />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === "terminal"}
                  onClick={() => setView({ kind: "terminal" })}
                >
                  <SquareTerminal />
                  Terminal
                  <Kbd className="ml-auto h-4 min-w-0 bg-transparent px-0 text-[10px] opacity-60 group-data-[collapsible=icon]:hidden">
                    {shortcut("terminal").keys.join(" ")}
                  </Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === "files"}
                  onClick={() => setView({ kind: "files" })}
                >
                  <Folder />
                  Files
                  <Kbd className="ml-auto h-4 min-w-0 bg-transparent px-0 text-[10px] opacity-60 group-data-[collapsible=icon]:hidden">
                    {shortcut("files").keys.join(" ")}
                  </Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center">
          <div className="flex items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="API keys"
                    onClick={() => setKeysOpen(true)}
                  >
                    <KeyRound />
                  </Button>
                }
              />
              <TooltipContent side="top">API keys &amp; models</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add skill"
                    onClick={() => setSkillsOpen(true)}
                  >
                    <PackagePlus />
                  </Button>
                }
              />
              <TooltipContent side="top">Add skill</TooltipContent>
            </Tooltip>
          </div>
          <div className="ml-auto flex items-center group-data-[collapsible=icon]:hidden">
            <TransferDialog />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
