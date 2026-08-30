// Best-effort scroll-position sync between the two split panes (§5.3, §6.1): the
// document (WYSIWYG) view and the Markdown source view. The same canonical
// markdown renders with very different block heights in each (a code block,
// image, or table is a different size in the document than in the raw source),
// and Crepe exposes no source map, so there's no exact line↔pixel correspondence
// to anchor on. Instead the panes are kept at the same *fractional* position:
// when one is scrolled, the other is moved to the same percentage of its own
// scrollable range. Good enough to keep the same region of the document in view
// in both panes while the user scrolls either one.
//
// Both panes scroll on their `.editor-pane` wrapper (overflow:auto in the split;
// see app.css §6.1 — CodeMirror runs height:auto so the wrapper scrolls, not
// `.cm-scroller`), so we listen on those wrapper elements directly.

/**
 * The `scrollTop` for `dst` that places it at the same fractional position as
 * `src`. Returns 0 when either pane can't scroll (content fits), which is the
 * only sensible mirror of a non-scrollable source. Pure (no DOM writes) so the
 * mapping is unit-testable without layout.
 */
export function mirroredScrollTop(
  src: { scrollTop: number; scrollHeight: number; clientHeight: number },
  dst: { scrollHeight: number; clientHeight: number },
): number {
  const srcMax = src.scrollHeight - src.clientHeight;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  if (srcMax <= 0 || dstMax <= 0) return 0;
  const ratio = src.scrollTop / srcMax;
  // Clamp: sub-pixel rounding (or a momentarily over-scrolled source) must never
  // push the destination past its own range.
  return Math.max(0, Math.min(dstMax, ratio * dstMax));
}

/** How long the user-scrolled pane stays the "driver" after its last scroll, so
 *  the mirrored pane's resulting scroll event is recognised as our own echo and
 *  ignored rather than fed back. Long enough to outlast the echo (which arrives
 *  within a frame), short enough that flicking the other pane feels responsive. */
const DRIVER_RELEASE_MS = 150;

/** How long `suppressNext()` ignores scrolls. Long enough to cover the async
 *  scroll event a programmatic scroll dispatches (~1 frame later); short enough
 *  that a real user scroll a moment afterwards still syncs. */
const SUPPRESS_MS = 100;

/**
 * Two-way fractional scroll sync between a pair of scroll containers.
 *
 * Feedback is the whole problem: mirroring A's scroll into B fires a scroll event
 * on B, which would mirror straight back into A, and so on. The guard is a
 * single "driver" lock — the pane the user is actually scrolling. While a driver
 * is set, the *other* pane's scroll events are treated as the programmatic echo
 * and dropped. The lock is released a short time (`DRIVER_RELEASE_MS`) after the
 * driver's last scroll, so continuous scrolling keeps driving without the panes
 * fighting, yet the roles can swap once the user moves to the other pane.
 */
export class ScrollSync {
  private a: HTMLElement | null = null;
  private b: HTMLElement | null = null;
  private driver: HTMLElement | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressing = false;
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;

  /** Listen on both panes and mirror either one's scroll into the other.
   *  Idempotent for the same pair; rewires (and drops the old listeners) when the
   *  elements change, e.g. after a pane rebuild or tab switch. */
  connect(a: HTMLElement, b: HTMLElement): void {
    if (this.a === a && this.b === b) return;
    this.disconnect();
    this.a = a;
    this.b = b;
    a.addEventListener("scroll", this.onScroll, { passive: true });
    b.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /** Ignore scrolls for a brief window — call right before a scroll the app
   *  originates itself (e.g. ProseMirror's `scrollIntoView` when Find jumps to a
   *  match, which fires per keystroke during incremental search). Without this
   *  such a scroll would be mistaken for a user gesture and jerk the other pane.
   *  Genuine wheel/keyboard/drag scrolling a moment later still syncs. */
  suppressNext(): void {
    this.suppressing = true;
    if (this.suppressTimer != null) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressing = false;
      this.suppressTimer = null;
    }, SUPPRESS_MS);
  }

  /** Stop syncing and release everything. Safe to call when not connected. */
  disconnect(): void {
    this.a?.removeEventListener("scroll", this.onScroll);
    this.b?.removeEventListener("scroll", this.onScroll);
    this.a = null;
    this.b = null;
    this.driver = null;
    this.suppressing = false;
    if (this.releaseTimer != null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (this.suppressTimer != null) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }

  private onScroll = (e: Event): void => {
    // An app-originated scroll (Find's scrollIntoView, etc.) — not a user gesture,
    // so don't let it drive the other pane.
    if (this.suppressing) return;
    const src = e.currentTarget as HTMLElement;
    // Drop the echo: the other pane is driving and this scroll is the one we just
    // applied to mirror it.
    if (this.driver !== null && this.driver !== src) return;
    const dst = src === this.a ? this.b : this.a;
    if (!dst) return;
    this.driver = src;
    if (this.releaseTimer != null) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.driver = null;
      this.releaseTimer = null;
    }, DRIVER_RELEASE_MS);
    dst.scrollTop = mirroredScrollTop(src, dst);
  };
}
