// WYSIWYG view: a lifecycle wrapper around Milkdown's Crepe editor, treated as
// a *view* over the canonical markdown string (docs/design.md §4).
//
// Three responsibilities beyond hosting Crepe:
//   - Serializer style (§5.16): configure remark-stringify options from settings.
//   - Frontmatter (§5.17): a leading `---` YAML block is split off and projected
//     through a React-owned editable table above the editor; Crepe only sees the
//     body, and the block and the blank lines after it are written back
//     unchanged on serialize.
//   - Exact source: until the user changes the body, it is reported as the text
//     Crepe parsed, not Milkdown's rewrite of it.

import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx, editorViewCtx } from "@milkdown/kit/core";
import { $prose, insert, replaceAll as replaceAllMarkdown } from "@milkdown/kit/utils";
import { Plugin, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

import type { SerializerStyle } from "../../state/types";
import { stringifyOptions } from "./serializer";
import { smartPastePlugin } from "./pasteHandler";
import { linkViewPlugin } from "./linkView";
import { pruneMermaidPreviews, renderMermaidPreview } from "./mermaid";
import { imageBlockFeatureConfig, type ViewRef } from "./imageView";
import { imageBlockAltSchema, imageBlockAltView } from "./imageBlockAlt";
import { tightListItemJoin, tightListItemSchema } from "./tightListItems";
import { imageContextMenuPlugin } from "./imageContextMenu";
import {
  searchMilkdownPlugin,
  runSearch,
  moveMatch,
  replaceCurrent,
  replaceAll,
  clearSearch,
  type FindCounts,
  type FindOptions,
} from "./findEngine";
import type { WysiwygContext } from "./context";
import { FrontmatterPanel, type FrontmatterFocus } from "./FrontmatterPanel";
import { installEditorAccessibility } from "./editorAccessibility";

const NO_MATCHES: FindCounts = { total: 0, current: 0 };
/** How long typing must pause before an edit is reported (`onChange`). */
const CHANGE_DEBOUNCE_MS = 200;
import { splitFrontmatter, joinFrontmatter } from "../../document/frontmatter";

export interface WysiwygCallbacks {
  onChange: (markdown: string) => void;
}

export class WysiwygEditor {
  private crepe: Crepe | null = null;
  /** The in-flight Crepe create, if mount has not settled yet. Destruction waits
   *  for it before calling Crepe.destroy: create/destroy concurrently is not a
   *  supported lifecycle and can leave plugin views/listeners behind. */
  private createPromise: Promise<void> | null = null;
  /** Terminal, idempotent teardown. A pane can be torn down both by an in-flight
   *  host build noticing disposal and by the host's own disposal sweep. */
  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;
  /** `mount` enables listener callbacks on the next task. Keep the timer so a
   *  teardown in that gap cannot turn updates back on afterwards. */
  private enableUpdatesTimer: ReturnType<typeof setTimeout> | null = null;
  private ignoreUpdates = true;
  /** The frontmatter block with both delimiters and, unless it ends the file,
   *  the newline after it. Null without frontmatter. */
  private frontmatterBlock: string | null = null;
  /** The blank lines between the frontmatter block and the body. Crepe never
   *  sees them, so they are kept here and written back as they were. */
  private frontmatterSeparator = "";
  /** Stable host element for the React-owned frontmatter table. */
  private fmPanel: HTMLElement | null = null;
  /** React root that owns all content inside `fmPanel`. */
  private fmPanelRoot: Root | null = null;
  private onChange: ((markdown: string) => void) | null = null;
  /** The mount root and Crepe's body container, kept so `setMarkdown` can add or
   *  remove the frontmatter panel above the editor when the source changes. */
  private root: HTMLElement | null = null;
  private crepeRoot: HTMLElement | null = null;
  /** Whether a frontmatter table should be shown (the showFrontmatterPanel
   *  setting, captured at mount). */
  private showFmPanel = false;
  /** The body Crepe last parsed (at mount or `setMarkdown`) and Milkdown's
   *  serialization of it right after parsing. While the body still serializes
   *  that way, the user has not changed it, so `getMarkdown` reports the exact
   *  source instead of Milkdown's rewrite of it. */
  private baseline: { source: string; settled: string } | null = null;
  /** Pending report of document edits, set while typing has not paused yet. */
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Attributes/semantics applied to DOM owned by Crepe and embedded CodeMirror. */
  private accessibilityCleanup: (() => void) | null = null;

  async mount(
    root: HTMLElement,
    initial: string,
    cb: WysiwygCallbacks,
    style: SerializerStyle,
    context: WysiwygContext,
  ): Promise<void> {
    if (this.destroyed || this.crepe || this.createPromise) {
      throw new Error("WysiwygEditor instances can only be mounted once");
    }
    this.ignoreUpdates = true;
    this.onChange = cb.onChange;
    this.root = root;
    this.showFmPanel = context.getSettings().showFrontmatterPanel === true;

    // Frontmatter (§5.17): a leading `---` YAML block is ALWAYS split off and kept
    // verbatim (Crepe never sees it, so it can't mangle the YAML into headings).
    // It and the blank lines after it are written back unchanged on serialize.
    // When showFrontmatterPanel is on (the default) it's shown above the editor
    // as a VS Code-style editable key/value table; scalar edits patch the YAML
    // line-for-line, so the file's formatting is preserved. With the setting
    // off, the YAML is hidden here but still preserved and editable in the
    // Markdown view.
    const split = splitFrontmatter(initial);
    this.frontmatterBlock = split.frontmatter;
    this.frontmatterSeparator = split.separator;
    if (split.frontmatter && this.showFmPanel) {
      this.fmPanel = document.createElement("div");
      this.fmPanel.className = "frontmatter-table-wrap";
      root.appendChild(this.fmPanel);
      this.fmPanelRoot = createRoot(this.fmPanel);
      this.renderFrontmatter();
    }
    const crepeRoot = document.createElement("div");
    crepeRoot.className = "crepe-root";
    root.appendChild(crepeRoot);
    this.crepeRoot = crepeRoot;

    // Shared holder so the missing-image handler (a Crepe feature config) can
    // reach the live EditorView captured by the image context-menu plugin.
    const viewRef: ViewRef = { current: null };
    this.crepe = new Crepe({
      root: crepeRoot,
      // Crepe only ever sees the body (the frontmatter, if any, is split off above);
      // split.body === initial when there is no frontmatter.
      defaultValue: split.body,
      featureConfigs: {
        // Render ```mermaid code blocks as diagrams below the source (§5.2).
        [Crepe.Feature.CodeMirror]: { renderPreview: renderMermaidPreview },
        // Display linked images + missing-image placeholder/relocate (§5.5).
        [Crepe.Feature.ImageBlock]: imageBlockFeatureConfig(viewRef, context),
        // Crepe's default empty-line hint is "Please enter...".
        [Crepe.Feature.Placeholder]: { text: "Type / for blocks" },
      },
    });
    // Apply serialization style (bullets/emphasis/heading style, etc.) and
    // md-easy's text escaping.
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => stringifyOptions(prev, style));
    });
    // Keep standalone images' alt text, which Crepe overwrites with its resize
    // ratio. Must follow the ImageBlock feature so this node spec replaces Crepe's.
    this.crepe.editor.use(imageBlockAltSchema);
    // Show that alt text to screen readers instead of the caption.
    this.crepe.editor.use(imageBlockAltView);
    // Keep typed lists tight when an item gets a nested list.
    this.crepe.editor.use(tightListItemSchema);
    // Keep a blank line where a tight item's blocks would read back as something else.
    this.crepe.editor.config(tightListItemJoin);
    // Smart paste (§5.4): images, HTML→markdown, markdown-looking text.
    this.crepe.editor.use(smartPastePlugin(context));
    // Link rendering (§5.6): text-and-url suffix + Ctrl/Cmd-click to open.
    this.crepe.editor.use(linkViewPlugin(context));
    // Image context menu (§5.5) + publishes the EditorView into viewRef.
    this.crepe.editor.use(imageContextMenuPlugin(viewRef, context));
    // WYSIWYG find/replace search state + decorations (§5.13).
    this.crepe.editor.use(searchMilkdownPlugin());
    // Report document edits once typing pauses. md-easy keeps its own timer
    // rather than Milkdown's listener plugin, which compares against the
    // document it last reported itself. After `reportPendingChange`, an undo back
    // to that document would never be reported.
    this.crepe.editor.use(
      $prose(
        () =>
          new Plugin({
            state: {
              init: () => null,
              apply: (tr) => {
                // Like the listener plugin, skip changes kept out of undo history
                // (heading ids, list labels, the empty last line). They do not
                // change the Markdown. A plugin's follow-up to such a change is
                // skipped too. It carries that change as "appendedTransaction".
                const root = (tr.getMeta("appendedTransaction") as Transaction | undefined) ?? tr;
                if (tr.docChanged && root.getMeta("addToHistory") !== false) this.scheduleChange();
                return null;
              },
            },
          }),
      ),
    );
    const crepe = this.crepe;
    let createPromise: Promise<void> | null = null;
    try {
      // Keep even a synchronous create/config failure inside this lifecycle's
      // cleanup path; Promise.resolve alone cannot catch an exception thrown
      // while evaluating `crepe.create()`.
      createPromise = Promise.resolve(crepe.create()).then(() => undefined);
      this.createPromise = createPromise;
      await createPromise;
    } catch (err) {
      // A host disposed while creation was pending deliberately suppresses the
      // abandoned mount. A genuine create failure still reaches the caller after
      // best-effort cleanup of the partially-created editor.
      if (this.destroyed) return;
      await this.destroy().catch(() => {});
      throw err;
    } finally {
      if (createPromise && this.createPromise === createPromise) this.createPromise = null;
    }

    // React Strict Mode (or a real app teardown) may dispose the host while the
    // asynchronous Crepe create is in flight. Never arm callbacks for that dead
    // instance; destroy() already owns/awaits its terminal cleanup.
    if (this.destroyed || this.crepe !== crepe) return;
    // A split mirror sync that landed while Crepe was creating has already
    // replaced the body and recorded its own source. Keep that one.
    if (!this.baseline) this.rememberSource(split.body);
    this.accessibilityCleanup = installEditorAccessibility(crepeRoot);
    // Crepe adds an empty last line below a final list, code block, quote,
    // table, rule or image in the first transaction after create. Make that an
    // empty transaction kept out of undo history. Otherwise the list view's
    // first-frame selection or the first click gets the line recorded, and the
    // first Ctrl+Z only removes it (Crepe adds it straight back) and moves the
    // caret.
    this.withView((view) => view.dispatch(view.state.tr.setMeta("addToHistory", false)), undefined);
    this.enableUpdatesTimer = setTimeout(() => {
      this.enableUpdatesTimer = null;
      if (!this.destroyed && this.crepe === crepe) this.ignoreUpdates = false;
    }, 0);
  }

  /** The document as Markdown. Joins the frontmatter block, the blank lines
   *  after it and Crepe's body, and starts the body on a new line if the block
   *  ends without one. Milkdown leaves out the empty line Crepe keeps after a
   *  final list, code block, quote, table, rule or image. A body that still
   *  serializes as it did right after Crepe parsed it is reported as that exact
   *  source, so opening, mirroring or undoing back never rewrites text the user
   *  has not changed. */
  getMarkdown(): string {
    const body = this.bodyMarkdown();
    const baseline = this.baseline;
    return joinFrontmatter({
      frontmatter: this.frontmatterBlock,
      separator: this.frontmatterSeparator,
      body: baseline && body === baseline.settled ? baseline.source : body,
    });
  }

  /** Report an edit now instead of waiting for typing to pause. A caller that
   *  reads the document right away (Save) calls this first. The edit takes the
   *  usual `onChange` path, and the pending report is cancelled. */
  reportPendingChange(): void {
    if (this.changeTimer == null || this.ignoreUpdates) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.emitChange();
  }

  /** Insert markdown at the current selection (used by drag-and-drop, §5.4). */
  insertMarkdown(markdown: string): void {
    if (!this.crepe || !markdown) return;
    try {
      this.crepe.editor.action(insert(markdown));
    } catch {
      // Editor not ready / torn down mid-drop; ignore.
    }
  }

  /**
   * Replace the whole document to mirror an edit made in the other split pane
   * (§6.1). The frontmatter block is re-split (and its table re-rendered, added,
   * or removed as the source gains/loses a `---` block) and only the body is fed
   * to Crepe via `replaceAll`. This pane is the unfocused mirror, so the reset
   * selection/scroll is acceptable.
   *
   * The replacement is reported like an edit after a ~200ms pause
   * (`scheduleChange`). That report carries `markdown` itself, because the body
   * still serializes as it did right after this parse (`getMarkdown`), so the
   * host sees no change. The mirror never writes Milkdown's rewrite back over
   * the author's exact text.
   */
  setMarkdown(markdown: string): void {
    if (!this.crepe) return;
    const split = splitFrontmatter(markdown);
    this.frontmatterBlock = split.frontmatter;
    this.frontmatterSeparator = split.separator;
    this.syncFrontmatterPanel();
    try {
      this.crepe.editor.action(replaceAllMarkdown(split.body));
      // The doc updates synchronously with the dispatch.
      this.rememberSource(split.body);
    } catch {
      // Editor torn down mid-sync; ignore.
    }
  }

  /** Bring the frontmatter table into line with the current `frontmatterBlock`
   *  after a `setMarkdown` (§6.1): create the panel when the source just gained a
   *  `---` block, remove it when the block is gone, otherwise re-render in place.
   *  A no-op when the showFrontmatterPanel setting is off (the block is still kept
   *  for serialization, just not shown here). */
  private syncFrontmatterPanel(): void {
    if (!this.showFmPanel) return;
    if (this.frontmatterBlock != null) {
      if (!this.fmPanel) {
        const panel = document.createElement("div");
        panel.className = "frontmatter-table-wrap";
        // Sits above Crepe's body, as at mount.
        if (this.root && this.crepeRoot) this.root.insertBefore(panel, this.crepeRoot);
        else this.root?.appendChild(panel);
        this.fmPanel = panel;
        this.fmPanelRoot = createRoot(panel);
      }
      this.renderFrontmatter();
    } else if (this.fmPanel) {
      this.fmPanelRoot?.unmount();
      this.fmPanelRoot = null;
      this.fmPanel.remove();
      this.fmPanel = null;
    }
  }

  // ── Find/replace controller (§5.13), driven by the FindBar via EditorHost ──

  private withView<T>(fn: (view: EditorView) => T, fallback: T): T {
    if (!this.crepe) return fallback;
    try {
      return this.crepe.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
    } catch {
      return fallback;
    }
  }

  search(query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => runSearch(v, query, opts), NO_MATCHES);
  }

  findNext(): FindCounts {
    return this.withView((v) => moveMatch(v, 1), NO_MATCHES);
  }

  findPrev(): FindCounts {
    return this.withView((v) => moveMatch(v, -1), NO_MATCHES);
  }

  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => replaceCurrent(v, replacement, query, opts), NO_MATCHES);
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => replaceAll(v, replacement, query, opts), NO_MATCHES);
  }

  clearSearch(): void {
    this.withView((v) => clearSearch(v), undefined);
  }

  focus(): void {
    this.withView((v) => v.focus(), undefined);
  }

  /**
   * Wrap the current selection in a link (spec §5.6), for the right-click menu's
   * "Insert link…". Returns false when there is no editor, no `link` mark in the
   * schema, or nothing selected — the link text is the selection, so an empty
   * one has nothing to attach to. Goes through a transaction, so undo works.
   */
  insertLink(href: string): boolean {
    return this.withView((view) => {
      const { selection, schema } = view.state;
      const linkType = schema.marks.link;
      if (!linkType || selection.empty) return false;
      view.dispatch(
        view.state.tr.addMark(selection.from, selection.to, linkType.create({ href })).scrollIntoView(),
      );
      view.focus();
      return true;
    }, false);
  }

  /** Re-show after being hidden on a tab/view switch. ProseMirror reflows from
   *  the browser when un-hidden, so focusing the view is enough. */
  onShow(): void {
    this.focus();
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyed = true;
    this.ignoreUpdates = true;
    this.onChange = null;
    this.accessibilityCleanup?.();
    this.accessibilityCleanup = null;
    if (this.enableUpdatesTimer != null) {
      clearTimeout(this.enableUpdatesTimer);
      this.enableUpdatesTimer = null;
    }
    if (this.changeTimer != null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    this.fmPanelRoot?.unmount();
    this.fmPanelRoot = null;
    this.fmPanel = null;
    this.frontmatterBlock = null;
    this.frontmatterSeparator = "";
    this.root = null;
    this.crepeRoot = null;
    this.baseline = null;
    const crepe = this.crepe;
    const creating = this.createPromise;
    // Null this synchronously: all public operations become no-ops immediately,
    // even though Crepe's asynchronous destruction may take longer.
    this.crepe = null;

    this.destroyPromise = (async () => {
      // If disposal races mount, let create settle first. Its rejection is the
      // abandoned mount's concern; cleanup still gets a chance to run.
      if (creating) await creating.catch(() => {});
      if (crepe) await crepe.destroy();
      // Release the closed document's diagrams from the theme watcher.
      pruneMermaidPreviews();
    })();
    return this.destroyPromise;
  }

  /** Record the body Crepe just parsed, and how Milkdown writes it back, so
   *  `getMarkdown` can report that exact source until the body changes. */
  private rememberSource(source: string): void {
    this.baseline = { source, settled: this.bodyMarkdown() };
  }

  /** Crepe's document as Markdown. */
  private bodyMarkdown(): string {
    if (!this.crepe) return "";
    try {
      return this.crepe.getMarkdown();
    } catch {
      return "";
    }
  }

  /** Restart the wait for typing to pause before reporting the edit. */
  private scheduleChange(): void {
    if (this.changeTimer != null) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (!this.ignoreUpdates) this.emitChange();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Report the current Markdown (the exact source while the body is unchanged)
   *  through onChange. */
  private emitChange(): void {
    this.onChange?.(this.getMarkdown());
  }

  /** Project the current YAML block through the React-owned frontmatter view. */
  private renderFrontmatter(focus: FrontmatterFocus = null): void {
    if (!this.fmPanelRoot || this.frontmatterBlock == null) return;
    this.fmPanelRoot.render(
      createElement(FrontmatterPanel, {
        block: this.frontmatterBlock,
        focus,
        onBlockChange: (block: string, nextFocus?: Exclude<FrontmatterFocus, null>) => {
          this.frontmatterBlock = block;
          this.emitChange();
          // Structural changes alter line indices and must refresh the projection.
          // Plain scalar edits stay in the current contenteditable node so React
          // never disturbs its selection or caret.
          if (nextFocus) this.renderFrontmatter(nextFocus);
        },
      }),
    );
  }

}
