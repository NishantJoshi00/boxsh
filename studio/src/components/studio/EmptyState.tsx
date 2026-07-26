import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useStudio } from "@/lib/store";

const assetBase = import.meta.env.BASE_URL.replace(/\/?$/, "/");

export function EmptyState() {
  const addSession = useStudio((st) => st.addSession);
  return (
    <Empty className="h-full">
      <div className="flex -translate-y-8 flex-col items-center gap-4">
        <EmptyHeader className="max-w-lg gap-4">
          <img
            src={`${assetBase}brand/box-dither.png`}
            alt=""
            aria-hidden="true"
            className="w-full max-w-72 select-none object-contain opacity-60 invert dark:invert-0"
            draggable={false}
          />
          <div className="grid gap-2">
            <EmptyTitle className="text-[34.03px] leading-none">
              Your sandbox is empty
            </EmptyTitle>
            <EmptyDescription className="text-base">
              Start an agent session, or open the terminal.
            </EmptyDescription>
          </div>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => addSession()}>
            <Plus /> New session
          </Button>
        </EmptyContent>
      </div>
    </Empty>
  );
}
