// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { closeHistory, history, redo, undo, undoDepth } from "@milkdown/kit/prose/history";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { equationChange, isEquation, mapEquationTarget, type EquationTarget } from "./mathEditor";
import { WysiwygEditor } from "./WysiwygEditor";

const { openDialog } = vi.hoisted(() => ({
  openDialog: vi.fn<typeof import("./MathEditorDialog").openMathEditor>(),
}));
vi.mock("./MathEditorDialog", () => ({ openMathEditor: openDialog }));

// CodeMirror's viewport lifecycle has no layout to observe in jsdom.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    math_inline: {
      group: "inline", inline: true, atom: true,
      attrs: { value: { default: "x" }, format: { default: "kept" } },
    },
    code_block: {
      group: "block", content: "text*", code: true, marks: "",
      attrs: {
        language: { default: "LaTeX" },
        fenced: { default: false },
        meta: { default: 'title="formula.tex"' },
      },
    },
  },
  marks: { link: { attrs: { href: {} } } },
});

/** Collect formulas in document order, including formulas inside table cells. */
function equations(doc: ProseNode): EquationTarget[] {
  const targets: EquationTarget[] = [];
  doc.descendants((node, pos) => {
    if (isEquation(node)) targets.push({ pos, node });
  });
  return targets;
}

/** A state with text before and after one formula and a real undo history. */
function equationState(kind: "inline" | "block"): EditorState {
  const paragraph = schema.nodes.paragraph;
  const formula = kind === "inline"
    ? paragraph.create(null, schema.nodes.math_inline.create(
      { value: "x" }, null, [schema.marks.link.create({ href: "https://example.com/math" })],
    ))
    : schema.nodes.code_block.create(null, schema.text("x"));
  return EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [
      paragraph.create(null, schema.text("Before")),
      formula,
      paragraph.create(null, schema.text("After")),
    ]),
    plugins: [history()],
  });
}

describe("equation targets", () => {
  it("accepts inline and display equations but rejects fenced examples and other nodes", () => {
    expect(isEquation(schema.nodes.math_inline.create())).toBe(true);
    expect(isEquation(schema.nodes.code_block.create({ language: "lAtEx" }))).toBe(true);
    expect(isEquation(schema.nodes.code_block.create({ language: "latex", fenced: true }))).toBe(false);
    expect(isEquation(schema.nodes.code_block.create({ language: "javascript" }))).toBe(false);
    expect(isEquation(schema.nodes.paragraph.create())).toBe(false);
    expect(isEquation(null)).toBe(false);
  });

  it.each(["inline", "block"] as const)("maps a %s equation through edits before and after it", (kind) => {
    let state = equationState(kind);
    const target = equations(state.doc)[0];
    const before = state.tr.insertText("New ", 1);
    const moved = mapEquationTarget(before, target);
    expect(moved).toEqual({ pos: target.pos + 4, node: target.node });
    state = state.apply(before);

    const after = state.tr.insertText("!", state.doc.content.size - 1);
    expect(mapEquationTarget(after, moved)).toEqual(moved);
    state = state.apply(after);
    const saved = equationChange(state, moved, "y");
    expect(saved?.doc.nodeAt(target.pos + 4)?.type.name).toBe(target.node.type.name);
    expect(saved?.doc.textBetween(1, 11)).toBe("New Before");
    expect(mapEquationTarget(state.tr, moved)).toBe(moved);
    expect(mapEquationTarget(after, null)).toBeNull();
  });

  it.each(["inline", "block"] as const)("rejects a changed, deleted or replaced %s equation", (kind) => {
    const state = equationState(kind);
    const target = equations(state.doc)[0];
    const changed = equationChange(state, target, "y")!;
    expect(mapEquationTarget(changed, target)).toBeNull();
    expect(equationChange(state.apply(changed), target, "draft")).toBeNull();

    const deleted = state.tr.delete(target.pos, target.pos + target.node.nodeSize);
    expect(mapEquationTarget(deleted, target)).toBeNull();
    expect(equationChange(state.apply(deleted), target, "draft")).toBeNull();

    // A replacement can look identical while belonging to a different edit.
    const replaced = state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, target.node);
    expect(replaced.doc.eq(state.doc)).toBe(true);
    const invalid = mapEquationTarget(replaced, target);
    expect(invalid).toBeNull();
    expect(equationChange(state.apply(replaced), invalid, "draft")).toBeNull();
  });

  it("rejects a formula converted to a fenced example while its editor is open", () => {
    const state = equationState("block");
    const target = equations(state.doc)[0];
    const tr = state.tr.setNodeAttribute(target.pos, "fenced", true);
    expect(mapEquationTarget(tr, target)).toBeNull();
    const changed = state.apply(tr);
    const current = { pos: target.pos, node: changed.doc.nodeAt(target.pos)! };
    expect(equationChange(changed, current, "draft")).toBeNull();
  });
});

describe("equation changes", () => {
  it.each(["inline", "block"] as const)("changes a %s formula in one undo step and retains attributes and marks", (kind) => {
    const initial = equationState(kind);
    let state = initial.apply(initial.tr.insertText("Typed ", 1));
    const before = state.doc;
    const target = equations(before)[0];
    const tr = equationChange(state, target, "\\frac{a}{b}")!;
    const changed = tr.doc.nodeAt(target.pos)!;
    expect(changed.attrs).toEqual(kind === "inline"
      ? { ...target.node.attrs, value: "\\frac{a}{b}" }
      : target.node.attrs);
    expect(changed.marks).toEqual(target.node.marks);
    if (kind === "block") expect(changed.textContent).toBe("\\frac{a}{b}");
    state = state.apply(tr);
    // The controller closes the save group before subsequent typing.
    state = state.apply(closeHistory(state.tr));
    expect(undoDepth(state)).toBe(2);
    const saved = state.doc;
    const dispatch = (next: Transaction): void => { state = state.apply(next); };
    expect(undo(state, dispatch)).toBe(true);
    expect(state.doc.eq(before)).toBe(true);
    expect(undo(state, dispatch)).toBe(true);
    expect(state.doc.eq(initial.doc)).toBe(true);
    expect(redo(state, dispatch)).toBe(true);
    expect(redo(state, dispatch)).toBe(true);
    expect(state.doc.eq(saved)).toBe(true);
  });

  it.each(["inline", "block"] as const)("can clear a %s formula without creating empty text nodes", (kind) => {
    const state = equationState(kind);
    const target = equations(state.doc)[0];
    const tr = equationChange(state, target, "")!;
    const node = tr.doc.nodeAt(target.pos)!;
    expect(isEquation(node)).toBe(true);
    expect(kind === "inline" ? node.attrs.value : node.textContent).toBe("");
  });

  it("makes no document change when the draft is unchanged", () => {
    const state = equationState("inline");
    const target = equations(state.doc)[0];
    const tr = equationChange(state, target, "x")!;
    expect(tr.docChanged).toBe(false);
    expect(undoDepth(state.apply(tr))).toBe(0);
    expect(equationChange(state, null, "y")).toBeNull();
  });
});

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  openDialog.mockReset();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Mount Crepe so tests exercise the actual parser and source-preserving writer. */
async function open(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const crepe = (editor as unknown as { crepe: Crepe }).crepe;
  return { editor, view: crepe.editor.ctx.get(editorViewCtx), parse: crepe.editor.ctx.get(parserCtx) };
}

describe("equation Markdown", () => {
  it("writes edited inline and display math while preserving untouched source and fenced examples", { timeout: 60_000 }, async () => {
    const fenced = '```latex title="example.tex"\na=b\n```\n';
    const original = `Before  with  spaces.\n\n**$x$** and $z$.\n\n$$\na=b\n$$\n\n${fenced}`;
    const { editor, view, parse } = await open(original);
    const inline = equations(view.state.doc).find(({ node }) => node.type.name === "math_inline")!;
    view.dispatch(equationChange(view.state, inline, "\\frac{a}{b}")!);
    const block = equations(view.state.doc).find(({ node }) => node.type.name === "code_block")!;
    view.dispatch(equationChange(view.state, block, "c=d")!);
    const markdown = editor.getMarkdown()!;
    expect(markdown).toContain("Before  with  spaces.\n\n");
    expect(markdown).toContain("**$\\frac{a}{b}$** and $z$.");
    expect(markdown).toContain("$$\nc=d\n$$");
    expect(markdown).toContain(fenced);
    const reread = equations(parse(markdown)!);
    expect(reread.map(({ node }) => node.type.name === "math_inline" ? node.attrs.value : node.textContent))
      .toEqual(["\\frac{a}{b}", "z", "c=d"]);
    expect(reread[0].node.marks.map((mark) => mark.type.name)).toEqual(["strong"]);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toContain("$$\na=b\n$$");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });

  it("escapes formula pipes in a table without splitting the cell", { timeout: 60_000 }, async () => {
    const { editor, view, parse } = await open("| Formula | Note |\n| --- | --- |\n| $x$ | Keep |\n");
    const target = equations(view.state.doc)[0];
    const latex = "\\left|x\\right|";
    view.dispatch(equationChange(view.state, target, latex)!);
    const markdown = editor.getMarkdown()!;
    expect(markdown).toContain("\\left\\|x\\right\\|");
    const reread = parse(markdown)!;
    expect(equations(reread).map(({ node }) => node.attrs.value)).toEqual([latex]);
    const table = reread.firstChild!;
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.child(1).childCount).toBe(2);
    expect(table.child(1).child(1).textContent).toBe("Keep");
  });
});

describe("equation editor lifecycle", () => {
  it("rejects a stale draft and cancels open or loading dialogs when hidden or destroyed", { timeout: 60_000 }, async () => {
    const closed = vi.fn();
    openDialog.mockImplementation((options) => ({
      close() {
        closed();
        options.onClose();
      },
    }));
    const { editor, view } = await open("Before $x$ after.\n");
    /** Click the current formula after a mirror may have replaced its DOM. */
    const clickEquation = (): void => {
      view.dom.querySelector<HTMLElement>('span[data-type="math_inline"]')!.click();
    };

    clickEquation();
    expect(openDialog).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledTimes(1));
    const draft = openDialog.mock.calls[0][0];
    expect(draft.latex).toBe("x");
    expect(draft.display).toBe(false);

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    const focus = vi.spyOn(view, "focus");
    const mirrored = "Before $y$ after.\n";
    editor.setMarkdown(mirrored);
    expect(draft.onSave("stale draft")).toBe(false);
    expect(editor.getMarkdown()).toBe(mirrored);
    expect(closed).not.toHaveBeenCalled();

    editor.onHide();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(draft.onSave("late save")).toBe(false);
    expect(editor.getMarkdown()).toBe(mirrored);
    expect(document.activeElement).toBe(elsewhere);
    expect(focus).not.toHaveBeenCalled();

    // A layout switch can happen before the dynamic import resolves.
    clickEquation();
    editor.onHide();
    await vi.dynamicImportSettled();
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();

    clickEquation();
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledTimes(2));
    const finalDraft = openDialog.mock.calls[1][0];
    const beforeDestroy = view.state.doc;
    await editor.destroy();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(view.isDestroyed).toBe(true);
    expect(finalDraft.onSave("save after teardown")).toBe(false);
    finalDraft.onClose();
    // The detached editor must no longer respond to formula clicks.
    clickEquation();
    await vi.dynamicImportSettled();
    expect(openDialog).toHaveBeenCalledTimes(2);
    expect(view.state.doc.eq(beforeDestroy)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });
});
