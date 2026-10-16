// Undo and redo for the frontmatter table (spec §5.17). The table edits the
// YAML block outside ProseMirror, so ProseMirror's undo history never saw its
// edits. Each change to the block is now a ProseMirror step instead, which the
// history records along with the body's edits. Ctrl+Z and Ctrl+Y then take
// back table and body edits in the order they were made, from either place.
//   - `FrontmatterStep` holds the block and the blank lines after it, before
//     and after the change, so the history can invert it. It leaves the
//     document's nodes as they are, so the view draws nothing again. (A
//     document attribute would make ProseMirror draw the whole document again
//     on every keystroke in a cell.)
//   - `frontmatterState` keeps the block and the blank lines in the editor
//     state and tells WysiwygEditor when they change.
//   - `handleTableHistory` runs the document's undo and redo for the keys and
//     the browser's Undo and Redo commands in the table.

import { $prose } from "@milkdown/kit/utils";
import { redo, undo } from "@milkdown/kit/prose/history";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Step, StepResult } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";

/** What the document view keeps of a file outside ProseMirror. */
export interface Frontmatter {
  /** The block with both delimiters, or null when the file has none. */
  block: string | null;
  /** The blank lines between the block and the body. Only a split mirror sync
   *  changes them. */
  separator: string;
}

/** Whether `a` and `b` hold the same text. */
function same(a: Frontmatter, b: Frontmatter): boolean {
  return a.block === b.block && a.separator === b.separator;
}

/** A change to the frontmatter. The document's nodes stay as they are. */
class FrontmatterStep extends Step {
  constructor(
    readonly before: Frontmatter,
    readonly after: Frontmatter,
  ) {
    super();
  }

  /** Keep the document itself, so the view has nothing to draw again. */
  apply(doc: Node): StepResult {
    return StepResult.ok(doc);
  }

  /** The step that puts the frontmatter back. */
  invert(): Step {
    return new FrontmatterStep(this.after, this.before);
  }

  /** The frontmatter has no positions, so no other change moves it. */
  map(): Step {
    return this;
  }

  /** One step for this change and `other` after it, so a run of typing in a
   *  cell keeps two blocks in the history instead of two per keystroke. */
  merge(other: Step): Step | null {
    return other instanceof FrontmatterStep && same(other.before, this.after)
      ? new FrontmatterStep(this.before, other.after)
      : null;
  }

  /** The history keeps its steps in memory, so nothing reads this back and
   *  the step registers no JSON id. */
  toJSON(): { stepType: string; before: Frontmatter; after: Frontmatter } {
    return { stepType: "mdEasyFrontmatter", before: this.before, after: this.after };
  }
}

const NO_FRONTMATTER: Frontmatter = { block: null, separator: "" };
const frontmatterKey = new PluginKey<Frontmatter>("md-easy-frontmatter");

/** The frontmatter after `steps`, starting from `frontmatter`. */
function afterSteps(frontmatter: Frontmatter, steps: readonly Step[]): Frontmatter {
  return steps.reduce((current, step) => (step instanceof FrontmatterStep ? step.after : current), frontmatter);
}

/** The frontmatter in `state`. Its block is null when the document has none. */
export function frontmatterOf(state: EditorState): Frontmatter {
  return frontmatterKey.getState(state) ?? NO_FRONTMATTER;
}

/** Add a step to `tr`, a transaction started from `state`, that sets the
 *  frontmatter's block, and its blank lines when `change` gives them. Adds
 *  nothing when the frontmatter is that already. */
export function setFrontmatter(state: EditorState, tr: Transaction, change: Partial<Frontmatter>): Transaction {
  const before = afterSteps(frontmatterOf(state), tr.steps);
  const after = { ...before, ...change };
  return same(before, after) ? tr : tr.step(new FrontmatterStep(before, after));
}

/** Milkdown plugin that keeps the frontmatter in the editor state. A new state
 *  starts with `init()`. `changed` is called after each update that changed
 *  the frontmatter, with the state before it. */
export function frontmatterState(
  init: () => Frontmatter,
  changed: (view: EditorView, prev: EditorState) => void,
) {
  return $prose(
    () =>
      new Plugin<Frontmatter>({
        key: frontmatterKey,
        state: { init, apply: (tr, frontmatter) => afterSteps(frontmatter, tr.steps) },
        view: () => ({
          update: (view, prev) => {
            if (!same(frontmatterOf(view.state), frontmatterOf(prev))) changed(view, prev);
          },
        }),
      }),
  );
}

/** `command`, the document's undo or redo, run from the table. When it changes
 *  the body, the document takes focus and shows the caret at the change, as
 *  undo in the document does. WysiwygEditor puts the caret in the table when
 *  only the table changed. */
function fromTable(command: Command): Command {
  return (state, dispatch, view) => {
    if (view && command(state, dispatch) && view.state.doc !== state.doc) {
      view.focus();
      view.dispatch(view.state.tr.scrollIntoView());
    }
    // Handled even with nothing to undo, so the browser's own undo never
    // changes a cell behind the history's back.
    return true;
  };
}

/** The keys Milkdown's history keymap binds in the document. Mod is Cmd on
 *  macOS and Ctrl elsewhere. */
const tableKeys = keydownHandler({
  "Mod-z": fromTable(undo),
  "Mod-y": fromTable(redo),
  "Shift-Mod-z": fromTable(redo),
});

/** Run the document's undo or redo for `event`, a key press or the browser's
 *  Undo or Redo command in the frontmatter table. Returns whether `event` was
 *  one of those, so the caller can prevent its default. */
export function handleTableHistory(view: EditorView, event: Event): boolean {
  if (event instanceof KeyboardEvent) return tableKeys(view, event);
  if (!(event instanceof InputEvent)) return false;
  const command = event.inputType === "historyUndo" ? undo : event.inputType === "historyRedo" ? redo : null;
  return command ? fromTable(command)(view.state, view.dispatch, view) : false;
}
