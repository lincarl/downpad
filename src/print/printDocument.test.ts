// @vitest-environment jsdom
import { Text } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { preparePrintJob } from "./printDocument";

const editorMocks = vi.hoisted(() => ({ findFromDOM: vi.fn() }));

vi.mock("@codemirror/view", () => ({ EditorView: editorMocks }));
vi.mock("../editor/wysiwyg/WysiwygEditor", () => ({ WysiwygEditor: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("prepares complete code and line numbers within a DOM argument limit", async () => {
  const sourceLines = Array.from({ length: 256 }, (_, index) => `line ${index + 1}`);
  sourceLines[1] = "";
  const doc = Text.of(sourceLines);
  editorMocks.findFromDOM.mockReturnValue({ state: { doc }, posAtDOM: () => 0 });
  const live = document.createElement("div");
  live.innerHTML = '<div class="cm-editor"><div class="cm-content"><div class="cm-line"><span class="syntax">line 1</span></div></div><div class="cm-gutters" style="min-height: 9000px"><div class="cm-lineNumbers"><div class="cm-gutterElement" style="visibility: hidden; height: 10px; margin-top: 20px">1</div></div></div></div>';

  // Model the browser's finite argument limit without building a huge fixture.
  const replaceChildren = Element.prototype.replaceChildren;
  vi.spyOn(Element.prototype, "replaceChildren").mockImplementation(function (this: Element, ...nodes) {
    if (nodes.length > 64) throw new RangeError("DOM argument limit exceeded");
    replaceChildren.call(this, ...nodes);
  });

  const job = await preparePrintJob({
    markdown: sourceLines.join("\n"),
    liveNode: live,
    settings: DEFAULT_SETTINGS,
    context: {
      getSettings: () => DEFAULT_SETTINGS,
      getFilePath: () => null,
      requestSave: async () => false,
    },
    docTitle: "large-code.md",
  });

  const printedLines = job!.documentNode!.querySelectorAll(".cm-content > .cm-line");
  expect(Array.from(printedLines, (line) => line.textContent)).toEqual(sourceLines);
  expect(printedLines[0]!.querySelector(".syntax")?.textContent).toBe("line 1");
  expect(printedLines[1]!.querySelector("br")).not.toBeNull();
  const numbers = job!.documentNode!.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement");
  expect(Array.from(numbers, (cell) => cell.textContent)).toEqual(sourceLines.map((_, index) => String(index + 1)));
  expect(numbers[0]!.style.cssText).toBe("");
  expect(live.querySelectorAll(".cm-line")).toHaveLength(1);
  expect(live.querySelector(".syntax")?.textContent).toBe("line 1");
});
