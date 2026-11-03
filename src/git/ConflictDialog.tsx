import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  dialogBodyClassName,
  dialogContentClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
} from "@/components/ui/dialog-layout";
import { cn } from "@/lib/utils";
import { timeAgo } from "./gitText";

/** What the user chose to do with changes that overlap someone else's. */
export type ConflictChoice = "discard" | "save-as" | "later";

export interface ConflictDialogOptions {
  /** The document's file name. */
  fileName: string;
  /** Who made the remote change, and when. */
  author: string;
  timeMs: number;
}

/**
 * Ask what to do when the user's changes and someone else's uploaded changes
 * touch the same parts of a document. Resolves "later" when the dialog is
 * closed without a choice. "Decide later" has focus first, so typing that was
 * meant for the document cannot choose anything else.
 */
export function openConflictDialog(options: ConflictDialogOptions): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.dataset.reactConflictDialog = "";
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (choice: ConflictChoice): void => {
      if (settled) return;
      settled = true;
      disposeReactRoot(root, host);
      resolve(choice);
    };
    flushSync(() => root.render(<ConflictDialog options={options} finish={finish} />));
  });
}

function ConflictDialog({ options, finish }: { options: ConflictDialogOptions; finish(choice: ConflictChoice): void }) {
  const laterRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish("later"); }}>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn("git-conflict-dialog", dialogContentClassName, "w-[min(500px,92vw)]")}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            laterRef.current?.focus();
          }}
        >
          <DialogTitle className={dialogTitleClassName}>Someone else changed this document</DialogTitle>
          <DialogDescription asChild>
            <div className={cn(dialogBodyClassName, "flex flex-col gap-2 pt-1")}>
              <p className="m-0">
                {options.author} changed “{options.fileName}” {timeAgo(options.timeMs)}, in the same places as your
                changes. Downpad cannot combine them.
              </p>
              <p className="m-0 text-ink-soft">
                Discard your changes to get their version, or save your version as a new file. Downpad keeps a copy
                of discarded changes for 30 days.
              </p>
            </div>
          </DialogDescription>
          <div className={dialogFooterClassName}>
            <Button type="button" variant="outline" onClick={() => finish("discard")}>
              Discard my changes
            </Button>
            <Button type="button" variant="outline" onClick={() => finish("save-as")}>
              Save mine as…
            </Button>
            <Button ref={laterRef} type="button" onClick={() => finish("later")}>
              Decide later
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
