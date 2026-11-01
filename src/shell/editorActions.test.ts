// @vitest-environment jsdom
// Undo and Redo from a native menu run the focused editor's history, and
// Chromium's own in a plain text field. Paste from the context menu hands the
// clipboard to the editor's own paste handling.

import { afterEach, describe, expect, it, vi } from "vitest";
import { RawEditor } from "../editor/raw/RawEditor";
import { paste, undoOrRedo, type EditableTarget } from "./editorActions";

let raw: RawEditor | null = null;
afterEach(() => {
  raw?.destroy();
  raw = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
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
    // The menu acts on the editor with the focus. insertText leaves focus alone.
    raw.focus();

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

/** jsdom has no DataTransfer. This one keeps the flavors and files a paste carries. */
class TestDataTransfer {
  readonly files: File[] = [];
  readonly items = {
    add: (file: File): void => {
      this.files.push(file);
    },
  };
  private readonly data = new Map<string, string>();
  get types(): string[] {
    return [...this.data.keys(), ...(this.files.length ? ["Files"] : [])];
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
}

/** jsdom has no ClipboardEvent either. */
class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer | null;
  constructor(type: string, init: ClipboardEventInit = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

/** Put `flavors` (type to content) on a stand-in system clipboard, and record
 *  the text that a paste puts in itself. */
function clipboard(flavors: Record<string, string>, { richReadRefused = false } = {}) {
  vi.stubGlobal("DataTransfer", TestDataTransfer);
  vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
  const read = vi.fn(async () => {
    if (richReadRefused) throw new DOMException("Read permission denied.", "NotAllowedError");
    return [{ types: Object.keys(flavors), getType: async (type: string) => new Blob([flavors[type]], { type }) }];
  });
  const readText = vi.fn(async () => flavors["text/plain"] ?? "");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read, readText } });
  const inserted: string[] = [];
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _showUi?: boolean, value?: string): boolean => {
      if (command === "insertText") inserted.push(value ?? "");
      return true;
    },
  });
  return { inserted };
}

/** An editable of `kind`, recording what each paste event on it carried. With
 *  `take`, its editor consumes the paste, as smart paste does. */
function editable(kind: EditableTarget["kind"], take: boolean) {
  const el = document.createElement(kind === "field" ? "input" : "div");
  document.body.append(el);
  const pastes: Array<{ text: string; html: string; files: string[] }> = [];
  el.addEventListener("paste", (event) => {
    const data = (event as ClipboardEvent).clipboardData!;
    pastes.push({
      text: data.getData("text/plain"),
      html: data.getData("text/html"),
      files: Array.from(data.files).map((file) => `${file.name} ${file.type}`),
    });
    if (take) event.preventDefault();
  });
  return { target: { el, kind }, pastes };
}

describe("Paste from the context menu", () => {
  const rich = { "text/plain": "a b", "text/html": "<p>a <b>b</b></p>", "image/png": "PNG" };

  it("hands the clipboard's text, HTML and image to the document as a paste", async () => {
    const { inserted } = clipboard(rich);
    const { target, pastes } = editable("wysiwyg", true);
    await paste(target, false);
    expect(pastes).toEqual([{ text: "a b", html: "<p>a <b>b</b></p>", files: ["pasted.png image/png"] }]);
    expect(inserted).toEqual([]);
  });

  it("puts the text in itself when no editor takes the paste", async () => {
    const { inserted } = clipboard(rich);
    const { target, pastes } = editable("raw", false);
    await paste(target, false);
    expect(pastes).toHaveLength(1);
    expect(inserted).toEqual(["a b"]);
  });

  it("puts in only the text for Paste as plain text and for a form field", async () => {
    const { inserted } = clipboard(rich);
    const documentView = editable("wysiwyg", true);
    await paste(documentView.target, true);
    const field = editable("field", true);
    await paste(field.target, false);
    expect(documentView.pastes).toEqual([]);
    expect(field.pastes).toEqual([]);
    expect(inserted).toEqual(["a b", "a b"]);
  });

  it("pastes the plain text when reading the rich clipboard is refused, and nothing from an empty clipboard", async () => {
    clipboard({ "text/plain": "plain words", "text/html": "<b>x</b>" }, { richReadRefused: true });
    const { target, pastes } = editable("wysiwyg", true);
    await paste(target, false);
    expect(pastes).toEqual([{ text: "plain words", html: "", files: [] }]);

    const { inserted } = clipboard({});
    await paste(target, false);
    expect(pastes).toHaveLength(1);
    expect(inserted).toEqual([]);
  });
});
