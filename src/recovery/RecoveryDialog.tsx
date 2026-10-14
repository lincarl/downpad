import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import type { Snapshot } from "@/ipc/contracts";
import { absoluteTime, relativeTime } from "@/home/relativeTime";
import { baseName } from "@/paste/dropHandler";
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

export interface RecoveryHandlers {
  openRecovered(snap: Snapshot): void | Promise<void>;
  openOriginal(snap: Snapshot): void | Promise<void>;
  discard(snap: Snapshot): void | Promise<void>;
}

export class RecoveryDialog {
  private root: Root | null = null;
  private host: HTMLElement | null = null;
  private resolve: (() => void) | null = null;

  open(snapshots: Snapshot[], handlers: RecoveryHandlers): Promise<void> {
    if (this.root) return Promise.resolve();
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.className = "recovery-dialog-root";
      document.body.append(host);
      const root = createRoot(host);
      this.host = host;
      this.root = root;
      this.resolve = resolve;
      flushSync(() => {
        root.render(
          <RecoveryDialogView
            snapshots={snapshots}
            handlers={handlers}
            onClose={() => this.close()}
          />,
        );
      });
    });
  }

  private close(): void {
    const root = this.root;
    const host = this.host;
    const resolve = this.resolve;
    this.root = null;
    this.host = null;
    this.resolve = null;
    if (root) disposeReactRoot(root, host);
    else host?.remove();
    resolve?.();
  }

  destroy(): void {
    this.close();
  }
}

/**
 * The startup recovery prompt. It cannot be dismissed with Escape or an outside
 * click: the user opens or discards each snapshot, or closes it explicitly. The
 * snapshots sit as rows in one list well, each with its own push buttons.
 */
function RecoveryDialogView({
  snapshots,
  handlers,
  onClose,
}: {
  snapshots: Snapshot[];
  handlers: RecoveryHandlers;
  onClose(): void;
}) {
  // Newest first, like Recent.
  const [remaining, setRemaining] = useState(() =>
    [...snapshots].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt)),
  );
  return (
    <Dialog open>
      <DialogPortal>
        <DialogOverlay className={cn("dialog-overlay", dialogOverlayClassName)} />
        <DialogContent
          className={cn("dialog recovery-dialog", dialogContentClassName, "w-[min(560px,92vw)]")}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogTitle asChild>
            <h2 className={cn("dialog-title", dialogTitleClassName)}>
              Recover unsaved work
            </h2>
          </DialogTitle>
          <DialogDescription asChild>
            <div className={cn("dialog-body", dialogBodyClassName)}>
              <p className="recovery-note m-0 pb-3 text-ink-soft">
                md-easy found unsaved work from a session that didn&apos;t close cleanly.
              </p>
              <div className="recovery-list overflow-hidden rounded-[6px] border border-line bg-well">
                {remaining.map((snapshot) => (
                  <RecoveryItem
                    key={snapshot.sessionId}
                    snapshot={snapshot}
                    handlers={handlers}
                    onOpened={onClose}
                    onDiscarded={() => {
                      const next = remaining.filter((item) => item !== snapshot);
                      setRemaining(next);
                      if (next.length === 0) onClose();
                    }}
                  />
                ))}
              </div>
            </div>
          </DialogDescription>
          <div className={cn("dialog-footer", dialogFooterClassName)}>
            <Button
              type="button"
              variant="outline"
              className={cn("dialog-btn", dialogButtonClassName)}
              onClick={onClose}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/** One snapshot row: name and age, the original path, a text preview and its actions. */
function RecoveryItem({
  snapshot,
  handlers,
  onOpened,
  onDiscarded,
}: {
  snapshot: Snapshot;
  handlers: RecoveryHandlers;
  onOpened(): void;
  onDiscarded(): void;
}) {
  return (
    <div className="recovery-item border-t border-line px-3 pb-3 pt-2.5 first:border-t-0">
      <div className="recovery-item-head flex items-baseline gap-3">
        <span className="recovery-item-name min-w-0 flex-1 truncate font-semibold text-ink-primary">
          {snapshot.filePath ? baseName(snapshot.filePath) : "Untitled document"}
        </span>
        <span
          className="recovery-item-time shrink-0 whitespace-nowrap text-[11px] text-ink-faint"
          title={absoluteTime(snapshot.savedAt)}
        >
          {relativeTime(snapshot.savedAt)}
        </span>
      </div>
      {snapshot.filePath && (
        <div className="recovery-item-path mt-0.5 text-[11px] leading-4 text-ink-soft [overflow-wrap:anywhere]">
          {snapshot.filePath}
        </div>
      )}
      <div className="recovery-item-preview mt-1.5 line-clamp-2 text-ink">
        {snippet(snapshot.markdown)}
      </div>
      <div className="recovery-item-actions mt-2.5 flex flex-wrap justify-end gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("dialog-btn", dialogButtonClassName)}
          onClick={async () => {
            await handlers.openRecovered(snapshot);
            onOpened();
          }}
        >
          Open recovered
        </Button>
        {snapshot.filePath && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("dialog-btn", dialogButtonClassName)}
            onClick={async () => {
              await handlers.openOriginal(snapshot);
              onOpened();
            }}
          >
            Open original
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("dialog-btn", dialogButtonClassName)}
          onClick={async () => {
            await handlers.discard(snapshot);
            onDiscarded();
          }}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

/** Plain-text preview: no frontmatter, heading or quote markers, whitespace collapsed. */
function snippet(markdown: string): string {
  const text = markdown
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/^ {0,3}(?:#{1,6}|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text || "(empty document)";
}
