import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const acknowledgementKey = "boxsh-browser-disclaimer-acknowledged";

export function BrowserDisclaimerDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(acknowledgementKey) !== "true");
    } catch {
      setOpen(true);
    }
  }, []);

  const acknowledge = () => {
    try {
      localStorage.setItem(acknowledgementKey, "true");
    } finally {
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        initialFocus={false}
        className="gap-5 p-6 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">
          Everything happens in your browser
        </DialogTitle>
        <DialogDescription className="space-y-4 text-[15px] leading-7">
          <span className="block text-foreground">Hello,</span>
          <span className="block">
            This is an experiment powered by{" "}
            <a
              href="https://www.npmjs.com/package/@boxsh/sandbox"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              @boxsh/sandbox
            </a>
            .
          </span>
          <span className="block">
            Everything you do here happens entirely inside this browser tab. The
            terminal, the file system, and even your agent sessions all run in
            your browser. There is no Boxsh server or backend.
          </span>
          <span className="block">
            Model requests go directly from your browser to the provider you
            choose.
          </span>
          <span className="block text-foreground">
            Thanks,
            <br />
            Nishant
          </span>
        </DialogDescription>
        <div className="flex justify-end">
          <Button type="button" onClick={acknowledge}>
            I understand
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
