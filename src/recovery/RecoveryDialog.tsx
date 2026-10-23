import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef, useState } from "react";
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
  /** Return false if opening was cancelled. Reject to keep the recovery choices
   *  visible with an error. Only a completed open closes the dialog. */
  openRecovered(snap: Snapshot): boolean | void | Promise<boolean | void>;
  openOriginal(snap: Snapshot): boolean | void | Promise<boolean | void>;
  discard(snap: Snapshot): void | Promise<void>;
}

const failureMessages = {
  openRecovered: "Could not open the recovered work. Please try again.",
  openOriginal: "Could not open the original file. Your recovered work is still available.",
  discard: "Could not discard the recovered work. Please try again.",
} satisfies Record<keyof RecoveryHandlers, string>;

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
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);

  /** Finish one choice before allowing another to open or discard its fallback. */
  async function act(action: keyof RecoveryHandlers, snapshot: Snapshot): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      if (await handlers[action](snapshot) === false) return;
      if (action === "discard") {
        const next = remaining.filter((item) => item !== snapshot);
        setRemaining(next);
        if (next.length === 0) onClose();
      } else {
        onClose();
      }
    } catch {
      setFailure({ id: snapshot.sessionId, message: failureMessages[action] });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

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
                    pending={pending}
                    failure={failure?.id === snapshot.sessionId ? failure.message : undefined}
                    onAction={(action) => void act(action, snapshot)}
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
              disabled={pending}
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
  pending,
  failure,
  onAction,
}: {
  snapshot: Snapshot;
  pending: boolean;
  failure?: string;
  onAction(action: keyof RecoveryHandlers): void;
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
        <div
          className="recovery-item-path mt-0.5 truncate text-left text-[11px] leading-4 text-ink-soft [direction:rtl]"
          title={snapshot.filePath}
        >
          {/* One line, shortened on the left so the file name stays visible. The
              left-to-right mark keeps a path's leading slash in place. */}
          {"\u200e" + snapshot.filePath}
        </div>
      )}
      <div className="recovery-item-preview mt-1.5 line-clamp-2 text-ink">
        {snippet(snapshot.markdown)}
      </div>
      {failure && <p role="alert" className="mb-0 mt-2 text-ink-danger">{failure}</p>}
      <div className="recovery-item-actions mt-2.5 flex flex-wrap justify-end gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("dialog-btn", dialogButtonClassName)}
          disabled={pending}
          onClick={() => onAction("openRecovered")}
        >
          Open recovered
        </Button>
        {snapshot.filePath && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("dialog-btn", dialogButtonClassName)}
            disabled={pending}
            onClick={() => onAction("openOriginal")}
          >
            Open original
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("dialog-btn", dialogButtonClassName)}
          disabled={pending}
          onClick={() => onAction("discard")}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

/** Plain-text preview: no frontmatter, heading or quote markers, whitespace collapsed. */
function snippet(markdown: string): string {
  // Blocks (a heading, then its paragraph) join with " · " so they don't run together.
  const text = markdown
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/^ {0,3}(?:#{1,6}|>)\s+/gm, "")
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  return text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text || "(empty document)";
}
