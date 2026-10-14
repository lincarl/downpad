import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef } from "react";
import { CircleHelp } from "lucide-react";
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
import { captureFocus } from "@/app/restoreFocus";
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
    const restoreFocus = captureFocus();
    let settled = false;
    const onAbort = (): void => finish("cancel");
    const finish = (action: MissingFileAction): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      disposeReactRoot(root, host);
      restoreFocus();
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

/**
 * Mervin's message box for a Recent entry whose file is gone: the title as the
 * first line, a question icon beside the main and informative text, and the
 * buttons in GNOME order with the accent "Locate" rightmost and focused.
 */
function MissingFileDialog({ name, finish }: { name: string; finish(action: MissingFileAction): void }) {
  const locateRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish("cancel"); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn(
            "dialog missing-dialog",
            dialogContentClassName,
            "w-max min-w-[min(400px,92vw)] max-w-[min(560px,92vw)]",
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            locateRef.current?.focus();
          }}
        >
          <DialogTitle asChild>
            <h2 className={cn("dialog-title", dialogTitleClassName)}>File not found</h2>
          </DialogTitle>
          <div className="flex min-h-0 items-start gap-[13px] px-[22px] pb-5 pt-1">
            <CircleHelp
              aria-hidden="true"
              focusable="false"
              className="shrink-0 text-ink-soft"
              size={32}
              absoluteStrokeWidth
              strokeWidth={1.5}
            />
            <DialogDescription asChild>
              <div className={cn("dialog-body", dialogBodyClassName, "min-w-0 px-0 pb-0 pt-1.5")}>
                <p className="missing-text m-0 text-ink [overflow-wrap:anywhere]">
                  &quot;{name}&quot; could not be found.
                </p>
                <p className="missing-subtext mb-0 mt-[7px] text-ink-soft">
                  It may have been moved, renamed, or deleted.
                </p>
              </div>
            </DialogDescription>
          </div>
          <div className={cn("dialog-footer", dialogFooterClassName)}>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => finish("remove")}
            >
              Remove from history
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={() => finish("cancel")}
            >
              Cancel
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
