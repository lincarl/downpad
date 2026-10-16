// @vitest-environment jsdom
// Undo and Redo from a native menu run the focused editor's history, and
// Chromium's own in a plain text field.

import { afterEach, describe, expect, it, vi } from "vitest";
import { RawEditor } from "../editor/raw/RawEditor";
import { undoOrRedo } from "./editorActions";

let raw: RawEditor | null = null;
afterEach(() => {
  raw?.destroy();
  raw = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Stand in for Chromium's undo, which jsdom lacks, and record its calls. */
function nativeUndo() {
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

/** The beforeinput events `element` sees, as their input type and target. */
function recordHistoryEvents(element: HTMLElement): string[] {
  const seen: string[] = [];
  element.addEventListener("beforeinput", (event) => {
    seen.push(`${(event as InputEvent).inputType} at ${(event.target as HTMLElement).className}`);
    event.preventDefault();
  });
  return seen;
}

describe("Undo and Redo from a native menu", () => {
  it("run the Markdown source's undo and redo, more than once", () => {
    const execCommand = nativeUndo();
    const root = document.createElement("div");
    document.body.append(root);
    raw = new RawEditor();
    raw.mount(root, "", { onChange: () => {} });
    // Two edits a second apart, so the history keeps them apart.
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    raw.insertText("one");
    clock.mockReturnValue(start + 1000);
    raw.insertText(" two");
    expect(raw.getText()).toBe("one two");

    undoOrRedo("undo");
    expect(raw.getText()).toBe("one");
    undoOrRedo("undo");
    expect(raw.getText()).toBe("");
    undoOrRedo("redo");
    undoOrRedo("redo");
    expect(raw.getText()).toBe("one two");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("send a code block's to the document, which runs undo for it", () => {
    const execCommand = nativeUndo();
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    const code = document.createElement("div");
    code.className = "cm-content";
    code.tabIndex = 0;
    editor.append(code);
    document.body.append(editor);
    const seen = recordHistoryEvents(editor);
    code.focus();

    undoOrRedo("undo");
    undoOrRedo("redo");
    expect(seen).toEqual(["historyUndo at ProseMirror", "historyRedo at ProseMirror"]);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("send the frontmatter table's to the focused cell", () => {
    const panel = document.createElement("div");
    panel.className = "frontmatter-table-wrap";
    const cell = document.createElement("div");
    cell.className = "frontmatter-value";
    cell.tabIndex = 0;
    panel.append(cell);
    document.body.append(panel);
    const seen = recordHistoryEvents(panel);
    cell.focus();

    undoOrRedo("redo");
    expect(seen).toEqual(["historyRedo at frontmatter-value"]);
  });

  it("keep Chromium's own undo and redo in a plain text field", () => {
    const execCommand = nativeUndo();
    const input = document.createElement("input");
    document.body.append(input);
    const seen = recordHistoryEvents(document.body);
    input.focus();

    undoOrRedo("undo");
    undoOrRedo("redo");
    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(seen).toEqual([]);
  });
});
