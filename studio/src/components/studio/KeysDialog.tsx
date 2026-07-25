import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PROVIDER_LABELS, type Provider } from "@/lib/models";
import { useStudio } from "@/lib/store";

function KeyField({ provider, placeholder }: { provider: Provider; placeholder: string }) {
  const key = useStudio((st) => st.keys[provider]);
  const setKey = useStudio((st) => st.setKey);

  return (
    <div className="grid gap-2">
      <Label htmlFor={`${provider}-key`}>{PROVIDER_LABELS[provider]} API key</Label>
      <Input
        id={`${provider}-key`}
        type="password"
        autoComplete="off"
        placeholder={placeholder}
        value={key}
        onChange={(e) => setKey(provider, e.target.value)}
      />
    </div>
  );
}

export function KeysDialog() {
  const open = useStudio((st) => st.keysOpen);
  const setOpen = useStudio((st) => st.setKeysOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>API keys</DialogTitle>
          <DialogDescription>Stored locally in your browser.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <KeyField provider="anthropic" placeholder="sk-ant-…" />
          <Separator />
          <KeyField provider="openai" placeholder="sk-…" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
