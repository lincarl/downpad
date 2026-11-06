import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { closeHistory } from "@milkdown/kit/prose/history";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import type { MathEditorHandle } from "./MathEditorDialog";

/** A formula and its location when the editing session last saw it. */
export interface EquationTarget {
  pos: number;
  node: ProseNode;
}

const equationKey = new PluginKey<EquationTarget | null>("downpad-equation");
const INLINE = 'span[data-type="math_inline"]';
const BLOCK = ".milkdown-code-block";

/** A real equation, excluding fenced LaTeX code examples. */
export function isEquation(node: ProseNode | null | undefined): node is ProseNode {
  return !!node && (node.type.name === "math_inline" || (
    node.type.name === "code_block" && !node.attrs.fenced &&
    typeof node.attrs.language === "string" && node.attrs.language.toLowerCase() === "latex"
  ));
}

/** Keep the target through unrelated edits, but never overwrite a changed or
 *  deleted equation, even if another formula moves into its old position. */
export function mapEquationTarget(tr: Transaction, target: EquationTarget | null): EquationTarget | null {
  if (!target || !tr.docChanged) return target;
  const mapped = tr.mapping.mapResult(target.pos, 1);
  const node = tr.doc.nodeAt(mapped.pos);
  if (mapped.deleted || !node?.eq(target.node)) return null;
  return { pos: mapped.pos, node };
}

/** Build one undoable change using the current node's attributes and marks. */
export function equationChange(state: EditorState, target: EquationTarget | null, latex: string): Transaction | null {
  if (!target) return null;
  const node = state.doc.nodeAt(target.pos);
  if (!isEquation(node) || !node.eq(target.node)) return null;
  const tr = closeHistory(state.tr);
  if (node.type.name === "math_inline") {
    if (node.attrs.value !== latex) tr.setNodeAttribute(target.pos, "value", latex);
  } else if (node.textContent !== latex) {
    tr.insertText(latex, target.pos + 1, target.pos + node.nodeSize - 1);
  }
  return tr;
}

/** Give inline equations a keyboard route without changing serialized math. */
function equationDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "math_inline") decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      role: "button",
      tabindex: "0",
      "aria-label": "Edit equation",
      "aria-description": node.attrs.value as string,
      "aria-haspopup": "dialog",
      title: "Edit equation",
      class: "math-edit-inline",
    }));
  });
  return DecorationSet.create(doc, decorations);
}

/** Resolve Crepe's DOM back to the equation, never to a neighbouring node. */
function equationAtElement(view: EditorView, element: Element): EquationTarget | null {
  const inline = element.closest(INLINE);
  const block = inline ? null : element.closest(BLOCK);
  if ((!inline && !block) || !view.dom.contains(inline ?? block)) return null;
  const inside = view.posAtDOM((inline ?? block)!, 0);
  const $pos = view.state.doc.resolve(inside);
  const pos = inline ? inside : $pos.depth > 0 ? $pos.before() : inside;
  const node = view.state.doc.nodeAt(pos);
  return isEquation(node) ? { pos, node } : null;
}

/** MathLive edits a draft. Only Apply dispatches a document transaction. The
 *  controller also closes drafts when the host hides a retained editor pane. */
export function mathEditor() {
  let dismiss: (() => void) | null = null;
  let decorated: { doc: ProseNode; set: DecorationSet } | null = null;
  const plugin = $prose(() => new Plugin<EquationTarget | null>({
    key: equationKey,
    state: {
      init: () => null,
      apply(tr, target) {
        const next = tr.getMeta(equationKey) as EquationTarget | null | undefined;
        return next === undefined ? mapEquationTarget(tr, target) : next;
      },
    },
    props: {
      decorations(state) {
        if (decorated?.doc !== state.doc) decorated = { doc: state.doc, set: equationDecorations(state.doc) };
        return decorated.set;
      },
    },
    view(view) {
      let dialog: MathEditorHandle | null = null;
      let generation = 0;
      let destroyed = false;
      let opening = false;
      let pressed: { x: number; y: number } | null = null;

      /** Clear a session before disposal so closing callbacks cannot refocus
       *  a hidden pane or dispatch into a destroyed editor. */
      const close = (): void => {
        if (!opening && !dialog) return;
        generation++;
        opening = false;
        const current = dialog;
        dialog = null;
        current?.close();
        if (!destroyed) view.dispatch(view.state.tr.setMeta(equationKey, null));
      };
      dismiss = close;

      /** Load MathLive only on first use, keeping normal document startup light. */
      const open = async (target: EquationTarget): Promise<void> => {
        if (opening || dialog || !view.editable) return;
        opening = true;
        const session = ++generation;
        const { state } = view;
        // A display equation remains a text editor. Selecting the entire block
        // made typing after Cancel replace it instead of returning to its code.
        const inside = state.selection instanceof TextSelection &&
          state.selection.from > target.pos && state.selection.to < target.pos + target.node.nodeSize;
        const selection = target.node.type.name === "math_inline"
          ? NodeSelection.create(state.doc, target.pos)
          : inside ? state.selection : TextSelection.create(state.doc, target.pos + target.node.nodeSize - 1);
        view.dispatch(state.tr.setSelection(selection).setMeta(equationKey, target));
        try {
          const { openMathEditor } = await import("./MathEditorDialog");
          if (destroyed || session !== generation) return;
          dialog = openMathEditor({
            latex: target.node.type.name === "math_inline" ? target.node.attrs.value as string : target.node.textContent,
            display: target.node.type.name === "code_block",
            onSave(latex) {
              if (destroyed || session !== generation) return false;
              const tr = equationChange(view.state, equationKey.getState(view.state) ?? null, latex);
              if (!tr) return false;
              if (tr.docChanged) {
                view.dispatch(tr);
                view.dispatch(closeHistory(view.state.tr));
              }
              return true;
            },
            onClose() {
              if (destroyed || session !== generation) return;
              dialog = null;
              opening = false;
              view.dispatch(view.state.tr.setMeta(equationKey, null));
              // Radix unmounts its focus trap on a microtask.
              queueMicrotask(() => {
                if (!destroyed && !view.isDestroyed && session === generation && view.dom.isConnected && !view.dom.closest("[hidden]")) view.focus();
              });
            },
          });
        } catch (error) {
          if (destroyed || session !== generation) return;
          close();
          console.error("Could not open the equation editor", error);
          window.alert("The equation editor could not load. You can still edit LaTeX in the Markdown view.");
        } finally {
          if (session === generation) opening = false;
        }
      };

      /** Crepe mounts and removes code-block tools as they enter and leave the
       *  viewport. Attach one real button to each mounted math toolbar. */
      const updateButtons = (): void => {
        for (const block of view.dom.querySelectorAll<HTMLElement>(BLOCK)) {
          const tools = block.querySelector(".tools-button-group");
          if (!tools) continue;
          const button = tools.querySelector(".math-edit-button");
          const target = equationAtElement(view, block);
          if (!target) {
            button?.remove();
            block.classList.remove("math-edit-block");
          } else {
            block.classList.add("math-edit-block");
            if (button) continue;
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "math-edit-button";
            edit.textContent = "Edit equation";
            edit.setAttribute("aria-haspopup", "dialog");
            tools.prepend(edit);
          }
        }
      };
      const observer = new MutationObserver((records) => {
        if (records.some((record) => [...record.addedNodes].some((node) => node instanceof Element &&
          (node.matches(".tools, .tools-button-group") || node.querySelector(".tools-button-group"))))) updateButtons();
      });
      observer.observe(view.dom, { childList: true, subtree: true });
      updateButtons();

      /** A click edits; modifiers and a drag keep the editor's selection rules. */
      const click = (event: MouseEvent): void => {
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !(event.target instanceof Element)) return;
        if (event.detail > 0 && pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) return;
        if (!event.target.closest(`${INLINE}, .math-edit-button, ${BLOCK} .preview`)) return;
        const target = equationAtElement(view, event.target);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void open(target);
      };
      const pointerdown = (event: PointerEvent): void => { pressed = { x: event.clientX, y: event.clientY }; };
      const keydown = (event: KeyboardEvent): void => {
        if (event.isComposing || event.shiftKey || event.altKey) return;
        const element = event.target instanceof Element ? event.target : null;
        const direct = element?.matches(`${INLINE}, .math-edit-button`);
        const selected = view.state.selection instanceof NodeSelection && isEquation(view.state.selection.node);
        const command = (event.ctrlKey || event.metaKey) && event.key === "Enter";
        if (!(direct && (event.key === "Enter" || event.key === " ")) &&
          !(event.target === view.dom && selected && event.key === "Enter") && !command) return;
        const target = direct || command ? element && equationAtElement(view, element) : selected ? {
          pos: view.state.selection.from, node: (view.state.selection as NodeSelection).node,
        } : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void open(target);
      };
      // CodeMirror's node view stops PM events, including those on its preview.
      view.dom.addEventListener("click", click, true);
      view.dom.addEventListener("pointerdown", pointerdown, true);
      view.dom.addEventListener("keydown", keydown, true);
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc) updateButtons();
        },
        destroy() {
          destroyed = true;
          close();
          dismiss = null;
          observer.disconnect();
          view.dom.removeEventListener("click", click, true);
          view.dom.removeEventListener("pointerdown", pointerdown, true);
          view.dom.removeEventListener("keydown", keydown, true);
        },
      };
    },
  }));
  return { plugin, close: () => dismiss?.() };
}
