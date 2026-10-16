// WYSIWYG view: a lifecycle wrapper around Milkdown's Crepe editor, treated as
// a *view* over the canonical markdown string (docs/design.md §4).
//
// Three responsibilities beyond hosting Crepe:
//   - Serializer style (§5.16): configure remark-stringify options from settings.
//   - Frontmatter (§5.17): a leading `---` YAML block is split off and projected
//     through a React-owned editable table above the editor; Crepe only sees the
//     body, and the block and the blank lines after it are written back
//     unchanged on serialize. Each change to them is a step in Crepe's undo
//     history (frontmatterHistory.ts), so undo takes back table and body edits
//     in one order.
//   - Exact source: until the user changes the body, it is reported as the text
//     Crepe parsed, not Milkdown's rewrite of it.

import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx, editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { indentPlugin } from "@milkdown/kit/plugin/indent";
import { $prose, insert } from "@milkdown/kit/utils";
import { Slice } from "@milkdown/kit/prose/model";
import { Plugin, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

import type { SerializerStyle } from "../../state/types";
import { stringifyOptions } from "./serializer";
import { smartPastePlugin } from "./pasteHandler";
import { copyWithoutTrailingLine } from "./copyTrailingLine";
import { linkViewPlugin } from "./linkView";
import { pruneMermaidPreviews, renderMermaidPreview } from "./mermaid";
import { imageBlockFeatureConfig, type ViewRef } from "./imageView";
import { imageBlockAltSchema, imageBlockAltView } from "./imageBlockAlt";
import { tightListItemJoin, tightListItemSchema } from "./tightListItems";
import { imageContextMenuPlugin } from "./imageContextMenu";
import { codeBlockMetaSchema } from "./codeBlockMeta";
import {
  searchMilkdownPlugin,
  type FindCounts,
  type FindOptions,
} from "./findEngine";
import { codeBlockFindHighlights } from "./findReveal";
import { findChangeListener } from "./findChanges";
import { DocumentFind } from "./documentFind";
import type { WysiwygContext } from "./context";
import { FrontmatterPanel, type FrontmatterFocus } from "./FrontmatterPanel";
import { changedCell, focusCaret, showsBlock } from "./frontmatterFind";
import { frontmatterOf, frontmatterState, handleTableHistory, setFrontmatter } from "./frontmatterHistory";
import { installEditorAccessibility, labelTaskBoxes } from "./editorAccessibility";
import { tabExit } from "./tabExit";
import { slashMenuBlur } from "./slashMenuBlur";

const NO_MATCHES: FindCounts = { total: 0, current: 0 };
/** How long typing must pause before an edit is reported (`onChange`). */
const CHANGE_DEBOUNCE_MS = 200;
/** A longer pause in typing starts a new undo step. This is ProseMirror
 *  history's default newGroupDelay, which Crepe keeps. */
const UNDO_GROUP_MS = 500;
import { splitFrontmatter, joinFrontmatter } from "../../document/frontmatter";

export interface WysiwygCallbacks {
  onChange: (markdown: string) => void;
  /** Called after an edit while a find query is set, so the find card can
   *  show the new count (§5.13). */
  onFindChange?: () => void;
  /** Called right before find scrolls the document to a match, which can be
   *  after the find step that asked for it has returned. */
  onFindScroll?: () => void;
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
   *  the newline after it. Null without frontmatter. The editor state holds it
   *  too, so undo can take its changes back (`frontmatterState`). This copy
   *  is the block the table shows, and after each update it equals the
   *  state's. */
  private frontmatterBlock: string | null = null;
  /** The blank lines between the frontmatter block and the body. Crepe never
   *  sees them, so they are kept here and written back as they were. The
   *  editor state holds them too, so undo of a mirror sync puts them back. */
  private frontmatterSeparator = "";
  /** Stable host element for the React-owned frontmatter table. */
  private fmPanel: HTMLElement | null = null;
  /** React root that owns all content inside `fmPanel`. */
  private fmPanelRoot: Root | null = null;
  private onChange: ((markdown: string) => void) | null = null;
  /** Told when the find matches may have changed without a find action. */
  private onFindChange: (() => void) | null = null;
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
  /** Bumped when undo, redo or Replace rewrites the frontmatter, so React draws
   *  a new table instead of patching cells the user has typed into. */
  private fmTableKey = 0;
  /** The cell the last keystroke in the table went to, its undo run, the
   *  editor state it left, its time and the input method composition it was
   *  part of. The next keystroke joins that run while all of them still hold,
   *  or while it is part of the same composition. */
  private typing: {
    cell: Element;
    run: string;
    state: EditorState;
    time: number;
    composition: number | null;
  } | null = null;
  /** Counts runs of typing in the table, to give each its own id. */
  private typingRuns = 0;
  /** Counts input method compositions in the table, to give each its own id. */
  private compositions = 0;
  /** The composition in progress in the table, or null between compositions.
   *  Chromium reports the text a composition commits before it ends it, so
   *  the commit is part of the composition too. */
  private composition: number | null = null;
  /** Find and replace over the frontmatter table and the document (§5.13). */
  private readonly find = new DocumentFind({
    block: () => (this.fmPanel ? this.frontmatterBlock : null),
    panel: () => this.fmPanel,
    changed: () => this.onFindChange?.(),
  });

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
    this.onFindChange = cb.onFindChange ?? null;
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
    this.syncFrontmatterPanel();
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
        // Render ```mermaid code blocks as diagrams below the source (§5.2), and
        // show the find card's matches inside code blocks (§5.13).
        [Crepe.Feature.CodeMirror]: {
          renderPreview: renderMermaidPreview,
          extensions: [codeBlockFindHighlights],
        },
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
    // Tell screen readers whether each task is done.
    this.crepe.editor.config(labelTaskBoxes);
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
    // Copy and drag without the empty line Crepe keeps after a final block.
    this.crepe.editor.use(copyWithoutTrailingLine);
    // Link rendering (§5.6): text-and-url suffix + Ctrl/Cmd-click to open.
    this.crepe.editor.use(linkViewPlugin(context));
    // Image context menu (§5.5) + publishes the EditorView into viewRef.
    this.crepe.editor.use(imageContextMenuPlugin(viewRef, context));
    // Keep fence info after the language, such as title="server.js". Must follow
    // the LaTeX feature so this node spec replaces Crepe's.
    this.crepe.editor.use(codeBlockMetaSchema);
    // WYSIWYG find/replace search state + decorations (§5.13).
    this.crepe.editor.use(searchMilkdownPlugin(() => cb.onFindScroll?.()));
    // Tab that the editor does not use, or Esc then Tab, moves focus out.
    this.crepe.editor.use(tabExit);
    // Focus that leaves the document closes the slash menu.
    this.crepe.editor.use(slashMenuBlur);
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
                // Skip the changes undo history leaves out, by the rule it uses.
                // That is a change kept out of history (heading ids, list labels,
                // the empty last line) or a plugin's follow-up to one, which
                // carries it as "appendedTransaction". They do not change the
                // Markdown.
                const root = tr.getMeta("appendedTransaction") as Transaction | undefined;
                const recorded = tr.getMeta("addToHistory") !== false && root?.getMeta("addToHistory") !== false;
                if (tr.docChanged && recorded) this.scheduleChange();
                return null;
              },
            },
          }),
      ),
    );
    // Tell the find card when an edit changes the matches (§5.13).
    this.crepe.editor.use(findChangeListener(() => this.onFindChange?.()));
    // Keep the frontmatter block and the blank lines after it in the editor
    // state, so undo and redo take back table edits along with the body's
    // (§5.17).
    this.crepe.editor.use(
      frontmatterState(
        () => ({ block: this.frontmatterBlock, separator: this.frontmatterSeparator }),
        (view, prev) => this.frontmatterChanged(view, prev),
      ),
    );
    const crepe = this.crepe;
    let createPromise: Promise<void> | null = null;
    try {
      // Keep even a synchronous create/config failure inside this lifecycle's
      // cleanup path. First drop Crepe's indent plugin, which types four spaces
      // on Tab that Markdown saves as `&#x20;`. Lists, tables and code blocks
      // have their own Tab keys.
      createPromise = crepe.editor.remove(indentPlugin).then(() => crepe.create()).then(() => undefined);
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
   * or removed as the source gains/loses a `---` block) and Crepe's body is
   * replaced. Both changes are one transaction, so an undo here takes back the
   * block and the body together. This pane is the unfocused mirror, so the
   * reset selection/scroll is acceptable. The table keeps its cells unless one
   * still shows text the block no longer has.
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
    // Draw the table at once, so the check below sees it.
    flushSync(() => this.syncFrontmatterPanel());
    // A cell whose typed text the Markdown pane took back can still show that
    // text (`showsBlock`), and the next keystroke there would write it back.
    // Then draw a new table. Otherwise React patches the cells it has, so a
    // click that brought this pane up to date (EditorHost's catch-up on
    // pointerdown) still lands in its cell.
    if (this.fmPanel && this.frontmatterBlock != null && !showsBlock(this.fmPanel, this.frontmatterBlock)) {
      this.fmTableKey += 1;
      flushSync(() => this.renderFrontmatter());
    }
    // Find again in a table this added; redraws of a shown table refresh on their own.
    this.find.refresh();
    try {
      // Milkdown's replaceAll, with the block and the blank lines after it in
      // the same transaction.
      this.crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const body = ctx.get(parserCtx)(split.body);
        const tr = view.state.tr.replace(0, view.state.doc.content.size, new Slice(body.content, 0, 0));
        view.dispatch(setFrontmatter(view.state, tr, { block: split.frontmatter, separator: split.separator }));
      });
      // The doc updates synchronously with the dispatch.
      this.rememberSource(split.body);
    } catch {
      // Editor torn down mid-sync; ignore.
    }
  }

  /** Bring the frontmatter table into line with the current `frontmatterBlock`
   *  at mount, after a `setMarkdown` (§6.1) and after undo, redo or Replace:
   *  create the panel when the source just gained a `---` block, remove it when
   *  the block is gone, otherwise re-render in place. A no-op when the
   *  showFrontmatterPanel setting is off (the block is still kept for
   *  serialization, just not shown here). */
  private syncFrontmatterPanel(): void {
    if (!this.showFmPanel) return;
    if (this.frontmatterBlock != null) {
      if (!this.fmPanel) {
        const panel = document.createElement("div");
        panel.className = "frontmatter-table-wrap";
        // Sits above Crepe's body.
        if (this.root && this.crepeRoot) this.root.insertBefore(panel, this.crepeRoot);
        else this.root?.appendChild(panel);
        // Ctrl+Z and Ctrl+Y anywhere in the table run the document's undo and redo.
        panel.addEventListener("keydown", this.tableHistory);
        panel.addEventListener("beforeinput", this.tableHistory);
        // An input method composition is one undo step, however long the
        // user waits before choosing the text (recordTableEdit).
        panel.addEventListener("compositionstart", () => (this.composition = ++this.compositions));
        panel.addEventListener("compositionend", () => (this.composition = null));
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
    return this.withView((v) => this.find.search(v, query, opts), NO_MATCHES);
  }

  findNext(): FindCounts {
    return this.withView((v) => this.find.move(v, 1), NO_MATCHES);
  }

  findPrev(): FindCounts {
    return this.withView((v) => this.find.move(v, -1), NO_MATCHES);
  }

  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => this.find.replaceCurrent(v, replacement, query, opts), NO_MATCHES);
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    return this.withView((v) => this.find.replaceAll(v, replacement, query, opts), NO_MATCHES);
  }

  /** The current match and total, for a find card catching up with an edit. */
  currentCounts(): FindCounts {
    return this.withView((v) => this.find.counts(v), NO_MATCHES);
  }

  clearSearch(): void {
    this.withView((v) => this.find.clear(v), undefined);
  }

  /** Focus the document. While the find card's current match is in an editable
   *  frontmatter cell, focus that cell with the match selected instead. */
  focus(): void {
    if (this.find.focusCurrent()) return;
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
    this.find.dispose();
    this.fmPanelRoot?.unmount();
    this.fmPanelRoot = null;
    this.fmPanel = null;
    this.frontmatterBlock = null;
    this.frontmatterSeparator = "";
    this.typing = null;
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
        key: this.fmTableKey,
        block: this.frontmatterBlock,
        focus,
        onBlockChange: (block: string, nextFocus?: Exclude<FrontmatterFocus, null>) => {
          this.frontmatterBlock = block;
          this.withView((view) => this.recordTableEdit(view, block, !nextFocus), undefined);
          this.emitChange();
          // Structural changes alter line indices and must refresh the projection.
          // Plain scalar edits stay in the current contenteditable node so React
          // never disturbs its selection or caret.
          if (nextFocus) this.renderFrontmatter(nextFocus);
        },
      }),
    );
  }

  /** Put a table edit that set the block to `block` in the undo history. A
   *  keystroke (`typed`) joins the undo step of the ones before it in the same
   *  cell until typing pauses or anything else changes, as typing in the
   *  document does. The edits of one input method composition stay in one
   *  step even when the user pauses before choosing the text. */
  private recordTableEdit(view: EditorView, block: string, typed: boolean): void {
    const tr = setFrontmatter(view.state, view.state.tr, { block });
    const cell = typed ? document.activeElement : null;
    const composition = cell ? this.composition : null;
    const last = this.typing;
    const joins =
      cell &&
      last?.cell === cell &&
      last.state === view.state &&
      ((composition !== null && composition === last.composition) || tr.time - last.time < UNDO_GROUP_MS);
    const run = joins ? last.run : `frontmatter-${++this.typingRuns}`;
    // The history groups changes that carry the same composition id, which is
    // how ProseMirror keeps the keystrokes of an input method together. A
    // step in the table has no position next to the last change, so without
    // the id every keystroke would be its own undo step.
    view.dispatch(tr.setMeta("composition", run));
    this.typing = cell ? { cell, run, state: view.state, time: tr.time, composition } : null;
  }

  /** Show a frontmatter block that undo, redo or Replace has put in the editor
   *  state, and report it at once, as the table reports its own edits. The
   *  table draws it right away, as a new table, so no cell keeps text the user
   *  typed. When the focus was in this editor and the body did not change, the
   *  caret goes to the changed cell, as undo puts it at the change in the
   *  document. Undo and redo of a mirror sync also put back the blank lines
   *  after the block. Edits made in the table, and mirror syncs, show their
   *  frontmatter before it reaches the state, so they are left alone. */
  private frontmatterChanged(view: EditorView, prev: EditorState): void {
    const { block, separator } = frontmatterOf(view.state);
    const before = this.frontmatterBlock;
    if (block === before && separator === this.frontmatterSeparator) return;
    this.frontmatterSeparator = separator;
    if (block === before) {
      // Only the blank lines changed, which the table does not show.
      this.reportPendingChange();
      return;
    }
    const inTable = !!this.fmPanel?.contains(document.activeElement);
    const inEditor = inTable || view.hasFocus();
    this.frontmatterBlock = block;
    this.fmTableKey += 1;
    flushSync(() => this.syncFrontmatterPanel());
    this.find.refresh();
    this.reportPendingChange();

    const panel = this.fmPanel;
    if (!panel || !inEditor || view.state.doc !== prev.doc) return;
    const cell = before != null && block != null ? changedCell(before, block) : null;
    if ((cell && focusCaret(panel, cell)) || !inTable) return;
    // The changed row is gone or read-only, and the redraw took the focus. Like
    // Delete, leave it on Add field.
    const add = panel.querySelector<HTMLElement>(".frontmatter-add");
    if (add) add.focus();
    else view.focus();
  }

  /** Run the document's undo or redo for Ctrl+Z, Ctrl+Y or the browser's Undo
   *  and Redo commands in the frontmatter table. */
  private readonly tableHistory = (event: Event): void => {
    if (this.withView((view) => handleTableHistory(view, event), false)) event.preventDefault();
  };
}
