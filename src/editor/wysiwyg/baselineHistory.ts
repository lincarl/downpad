// Which body the document view's document came from, kept in its undo
// history. A split mirror sync replaces the body with the other pane's text,
// and the editor makes a new SourceBaseline for that text (sourceBaseline.ts).
// The replacement is a step in the document's undo history, so Ctrl+Z can
// bring back the body from before the sync. That body must then be written
// with its own baseline. With the new one, the blocks the sync changed would
// be written in Milkdown's form, and a document would get other text than it
// was saved with.
//   - `BaselineStep` holds the baseline before and after a sync, so the
//     history can invert it. It leaves the document's nodes as they are.
//   - `baselineState` keeps the current one in the editor state.

import { $prose } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Step, StepResult } from "@milkdown/kit/prose/transform";
import type { SourceBaseline } from "./sourceBaseline";

/** Where the baseline of a body goes. The editor makes it after the
 *  transaction that brings the body in, once Crepe has parsed the body. */
export interface BaselineSlot {
  baseline: SourceBaseline | null;
}

/** A change of the body's baseline. The document's nodes stay as they are. */
class BaselineStep extends Step {
  constructor(
    readonly before: BaselineSlot,
    readonly after: BaselineSlot,
  ) {
    super();
  }

  /** Keep the document itself, so the view has nothing to draw again. */
  apply(doc: Node): StepResult {
    return StepResult.ok(doc);
  }

  /** The step that puts the baseline back. */
  invert(): Step {
    return new BaselineStep(this.after, this.before);
  }

  /** The baseline has no positions, so no other change moves it. */
  map(): Step {
    return this;
  }

  /** The history keeps its steps in memory, so nothing reads this back and
   *  the step registers no JSON id. */
  toJSON(): { stepType: string } {
    return { stepType: "downpadBaseline" };
  }
}

const NO_BASELINE: BaselineSlot = { baseline: null };
const baselineKey = new PluginKey<BaselineSlot>("downpad-baseline");

/** The slot after `steps`, starting from `slot`. */
function afterSteps(slot: BaselineSlot, steps: readonly Step[]): BaselineSlot {
  return steps.reduce((current, step) => (step instanceof BaselineStep ? step.after : current), slot);
}

/** Milkdown plugin that keeps the slot of the body the document came from in
 *  the editor state. A new state starts with `opened`, the slot of the body
 *  the editor opened with. */
export function baselineState(opened: BaselineSlot) {
  return $prose(
    () =>
      new Plugin<BaselineSlot>({
        key: baselineKey,
        state: { init: () => opened, apply: (tr, slot) => afterSteps(slot, tr.steps) },
      }),
  );
}

/** Add a step to `tr`, a transaction started from `state`, that makes `slot`
 *  the body's baseline. */
export function setBaseline(state: EditorState, tr: Transaction, slot: BaselineSlot): Transaction {
  return tr.step(new BaselineStep(afterSteps(baselineKey.getState(state) ?? NO_BASELINE, tr.steps), slot));
}

/** The baseline of the body `state`'s document came from, or null when it
 *  has none yet. */
export function baselineOf(state: EditorState): SourceBaseline | null {
  return (baselineKey.getState(state) ?? NO_BASELINE).baseline;
}
