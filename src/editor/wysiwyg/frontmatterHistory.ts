// Undo and redo for the frontmatter table (spec §5.17). The table edits the
// YAML block outside ProseMirror, so ProseMirror's undo history never saw its
// edits. Each change to the block is now a ProseMirror step instead, which the
// history records along with the body's edits. Ctrl+Z and Ctrl+Y then take
// back table and body edits in the order they were made, from either place.
//   - `FrontmatterStep` holds the block before and after the change, so the
//     history can invert it. It leaves the document's nodes as they are, so the
//     view draws nothing again. (A document attribute would make ProseMirror
//     draw the whole document again on every keystroke in a cell.)
//   - `frontmatterState` keeps the block in the editor state and tells
//     WysiwygEditor when it changes.
//   - `handleTableHistory` runs the document's undo and redo for the keys and
//     the browser's Undo and Redo commands in the table.

import { $prose } from "@milkdown/kit/utils";
import { redo, undo } from "@milkdown/kit/prose/history";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Step, StepResult } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";

/** A change to the frontmatter block. The document's nodes stay as they are. */
class FrontmatterStep extends Step {
  constructor(
    readonly before: string | null,
    readonly after: string | null,
  ) {
    super();
  }

  /** Keep the document itself, so the view has nothing to draw again. */
  apply(doc: Node): StepResult {
    return StepResult.ok(doc);
  }

  /** The step that puts the block back. */
  invert(): Step {
    return new FrontmatterStep(this.after, this.before);
  }

  /** The block has no positions, so no other change moves it. */
  map(): Step {
    return this;
  }

  /** One step for this change and `other` after it, so a run of typing in a
   *  cell keeps two blocks in the history instead of two per keystroke. */
  merge(other: Step): Step | null {
    return other instanceof FrontmatterStep && other.before === this.after
      ? new FrontmatterStep(this.before, other.after)
      : null;
  }

  /** The history keeps its steps in memory, so nothing reads this back and
   *  the step registers no JSON id. */
  toJSON(): { stepType: string; before: string | null; after: string | null } {
    return { stepType: "mdEasyFrontmatter", before: this.before, after: this.after };
  }
}

const frontmatterKey = new PluginKey<string | null>("md-easy-frontmatter");

/** The block after `steps`, starting from `block`. */
function afterSteps(block: string | null, steps: readonly Step[]): string | null {
  return steps.reduce((current, step) => (step instanceof FrontmatterStep ? step.after : current), block);
}

/** The frontmatter block in `state`, or null when the document has none. */
export function frontmatterOf(state: EditorState): string | null {
  return frontmatterKey.getState(state) ?? null;
}

/** Add a step to `tr`, a transaction started from `state`, that sets the
 *  frontmatter block to `block`. Adds nothing when the block is that already. */
export function setFrontmatter(state: EditorState, tr: Transaction, block: string | null): Transaction {
  const before = afterSteps(frontmatterOf(state), tr.steps);
  return before === block ? tr : tr.step(new FrontmatterStep(before, block));
}

/** Milkdown plugin that keeps the frontmatter block in the editor state. A new
 *  state starts with `init()`. `changed` is called after each update that
 *  changed the block, with the state before it. */
export function frontmatterState(
  init: () => string | null,
  changed: (view: EditorView, prev: EditorState) => void,
) {
  return $prose(
    () =>
      new Plugin<string | null>({
        key: frontmatterKey,
        state: { init, apply: (tr, block) => afterSteps(block, tr.steps) },
        view: () => ({
          update: (view, prev) => {
            if (frontmatterOf(view.state) !== frontmatterOf(prev)) changed(view, prev);
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
