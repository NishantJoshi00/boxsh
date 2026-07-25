import { Box, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useStudio } from "@/lib/store";

export function EmptyState() {
  const addSession = useStudio((st) => st.addSession);
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Box />
        </EmptyMedia>
        <EmptyTitle>Your sandbox is empty</EmptyTitle>
        <EmptyDescription>
          Start an agent session, or open the terminal.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={() => addSession()}>
          <Plus /> New session
        </Button>
      </EmptyContent>
    </Empty>
  );
}
