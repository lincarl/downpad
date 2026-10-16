// @vitest-environment jsdom
// Undo and redo for the frontmatter table above the document. Its edits share
// the document's undo history, so Ctrl+Z and Ctrl+Y take back table and body
// edits in the order they were made. These tests use the real editor.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import type { FindOptions } from "./findEngine";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

// jsdom has no isContentEditable. The table's cells are editable exactly when
// they carry the contenteditable attribute.
Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("contenteditable");
  },
});

const FILE = "---\ntitle: Draft notes # keep\nstatus: draft\n---\n\nThe draft body.\n";
const OPTS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** Wait for React to draw the table. */
const redraw = () => new Promise((resolve) => setTimeout(resolve, 60));

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports. */
async function open(markdown = FILE): Promise<{ editor: WysiwygEditor; onChange: Mock }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  await redraw();
  return { editor, onChange };
}

/** The table cell drawn for inner YAML line `line`. */
const cell = (line: number, part: "key" | "value") =>
  document.querySelector<HTMLElement>(`[data-line="${line}"][data-part="${part}"]`)!;
const body = () => document.querySelector<HTMLElement>(".ProseMirror")!;

/** Focus `target` and type `text` at its end, one input event per character. */
function type(target: HTMLElement, text: string): void {
  target.focus();
  for (const char of text) {
    target.textContent += char;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Press Ctrl and `key` on `target`, as the keyboard does on Windows and Linux. */
function press(target: Element, key: string, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
}

/** The latest Markdown the editor reported, after any report still waiting. */
function reported(ed: WysiwygEditor, onChange: Mock): string {
  ed.reportPendingChange();
  return String(onChange.mock.lastCall?.[0]);
}

describe("undo in the frontmatter table", () => {
  it("takes back what was typed in a cell with Ctrl+Z and brings it back with Ctrl+Y", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    type(cell(0, "value"), " v2");
    expect(reported(editor, onChange)).toBe(FILE.replace("# keep", "# keep v2"));

    // One step for the whole run of typing. The caret stays in the cell, where the text was.
    press(cell(0, "value"), "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE);
    expect(cell(0, "value").textContent).toBe("Draft notes # keep");
    expect(document.activeElement).toBe(cell(0, "value"));
    const selection = window.getSelection()!;
    expect([selection.anchorNode?.textContent, selection.anchorOffset]).toEqual(["Draft notes # keep", 18]);

    press(document.activeElement!, "y");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE.replace("# keep", "# keep v2"));
    expect(cell(0, "value").textContent).toBe("Draft notes # keep v2");
    // The browser's Undo command, as from the native context menu.
    document.activeElement!.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }),
    );
    expect(onChange.mock.lastCall?.[0]).toBe(FILE);
  });

  it("starts a new step for another cell and after a pause in typing", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    type(cell(0, "value"), "1");
    clock.mockReturnValue(start + 600);
    type(cell(0, "value"), "2");
    type(cell(1, "value"), "3");
    expect(reported(editor, onChange)).toBe(FILE.replace("# keep", "# keep12").replace("draft\n", "draft3\n"));

    press(document.activeElement!, "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE.replace("# keep", "# keep12"));
    press(document.activeElement!, "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE.replace("# keep", "# keep1"));
    press(document.activeElement!, "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE);
  });

  it("keeps an input method composition in one step when the user pauses before choosing the text", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const title = cell(0, "value");
    title.focus();
    /** Compose `steps` at the end of the title cell, each a reading or the
     *  chosen text and the time it is typed, in Chromium's order of events. */
    const compose = (steps: ReadonlyArray<readonly [string, number]>): void => {
      title.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const original = title.textContent;
      for (const [text, time] of steps) {
        clock.mockReturnValue(start + time);
        title.textContent = original + text;
        title.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: text }));
      }
      title.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: steps.at(-1)![0] }));
    };
    // "nihon", then a pause before choosing 日本.
    compose([["に", 0], ["にほ", 150], ["にほん", 300], ["日本", 1500]]);
    // A second composition after a pause.
    compose([["ご", 3000], ["語", 3100]]);
    expect(reported(editor, onChange)).toBe(FILE.replace("# keep", "# keep日本語"));

    // Each composition is one step, and its undo leaves no reading behind.
    press(title, "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE.replace("# keep", "# keep日本"));
    press(document.activeElement!, "z");
    expect(onChange.mock.lastCall?.[0]).toBe(FILE);
  });

  it("takes back table and body edits in the order they were made, from either place", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    type(cell(0, "value"), " v2");
    const typed = FILE.replace("# keep", "# keep v2");
    editor.insertMarkdown("Typed.");
    const both = reported(editor, onChange);
    expect(both).toContain("Typed.");

    // Ctrl+Z in the document takes back the body's edit, then the table's,
    // and puts the caret in the cell.
    press(body(), "z");
    expect(reported(editor, onChange)).toBe(typed);
    press(body(), "z");
    expect(reported(editor, onChange)).toBe(FILE);
    expect(document.activeElement).toBe(cell(0, "value"));

    // Ctrl+Shift+Z in the cell redoes the table's edit, then the body's, and
    // moves the caret to the body.
    press(cell(0, "value"), "z", true);
    expect(reported(editor, onChange)).toBe(typed);
    press(cell(0, "value"), "z", true);
    expect(reported(editor, onChange)).toBe(both);
    expect(document.activeElement).toBe(body());
  });

  it("takes back Replace all in the table and the document with one Ctrl+Z", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    editor.search("draft", OPTS);
    editor.replaceAll("final", "draft", OPTS);
    expect(reported(editor, onChange)).toBe("---\ntitle: final notes # keep\nstatus: final\n---\n\nThe final body.\n");
    editor.clearSearch();
    press(body(), "z");
    expect(reported(editor, onChange)).toBe(FILE);
    expect(cell(0, "value").textContent).toBe("Draft notes # keep");
  });

  it("brings back a deleted field", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open();
    cell(1, "value").parentElement!.querySelector<HTMLElement>('[aria-label="Delete"]')!.click();
    await redraw();
    expect(reported(editor, onChange)).toBe(FILE.replace("status: draft\n", ""));
    // Delete leaves the focus on Add field, where Ctrl+Z works too.
    expect(document.activeElement?.textContent).toBe("Add field");
    press(document.activeElement!, "z");
    expect(reported(editor, onChange)).toBe(FILE);
    expect(cell(1, "value").textContent).toBe("draft");
  });

  it("takes back a mirrored Markdown edit to the frontmatter along with the body", { timeout: 60_000 }, async () => {
    const { editor } = await open();
    editor.setMarkdown(FILE.replace("Draft", "Mirrored").replace("The draft", "The mirrored"));
    press(body(), "z");
    expect(editor.getMarkdown()).toBe(FILE);
  });
});
