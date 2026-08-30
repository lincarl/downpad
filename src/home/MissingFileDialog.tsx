import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  dialogBodyClassName,
  dialogButtonClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
} from "@/components/ui/dialog-layout";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { cn } from "@/lib/utils";

export type MissingFileAction = "locate" | "remove" | "cancel";

export function openMissingFileDialog(
  name: string,
  signal?: AbortSignal,
): Promise<MissingFileAction> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "missing-dialog-root";
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const onAbort = (): void => finish("cancel");
    const finish = (action: MissingFileAction): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      disposeReactRoot(root, host);
      resolve(action);
    };
    if (signal?.aborted) {
      finish("cancel");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    flushSync(() => root.render(<MissingFileDialog name={name} finish={finish} />));
  });
}

function MissingFileDialog({ name, finish }: { name: string; finish(action: MissingFileAction): void }) {
  const locateRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish("cancel"); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn("dialog missing-dialog", dialogContentClassName)}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            locateRef.current?.focus();
          }}
        >
          <DialogTitle asChild>
            <h2 className={cn("dialog-title", dialogTitleClassName)}>File not found</h2>
          </DialogTitle>
          <DialogDescription asChild>
            <div className={cn("dialog-body", dialogBodyClassName)}>
              <p className="missing-text mb-1.5 mt-0 text-sm">
                &quot;{name}&quot; could not be found.
              </p>
              <p className="missing-subtext m-0 text-[13px] text-muted-foreground">
                It may have been moved, renamed, or deleted.
              </p>
            </div>
          </DialogDescription>
          <div className={cn("dialog-footer", dialogFooterClassName)}>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => finish("cancel")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => finish("remove")}
            >
              Remove from history
            </Button>
            <Button
              ref={locateRef}
              type="button"
              className={cn("dialog-btn primary", dialogButtonClassName)}
              onClick={() => finish("locate")}
            >
              Locate
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
