// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { preparePrintJob } from "./printDocument";

vi.mock("../editor/wysiwyg/WysiwygEditor", () => ({ WysiwygEditor: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("prints offscreen code placeholders with every line and its number without changing the editor", async () => {
  const sourceLines = Array.from({ length: 256 }, (_, index) => `const line${index + 1} = '<tag>';`);
  sourceLines[1] = "";
  sourceLines[sourceLines.length - 1] = "";
  const live = document.createElement("div");
  live.innerHTML = '<div class="milkdown-code-block"><pre class="milkdown-code-block-placeholder"><code></code></pre></div>';
  live.querySelector("code")!.textContent = sourceLines.join("\n");
  const original = live.outerHTML;
  const destroy = vi.spyOn(EditorView.prototype, "destroy");

  const job = await preparePrintJob({
    markdown: `\`\`\`ts\n${sourceLines.join("\n")}\n\`\`\``,
    liveNode: live,
    settings: DEFAULT_SETTINGS,
    context: {
      getSettings: () => DEFAULT_SETTINGS,
      getFilePath: () => null,
      requestSave: async () => false,
    },
    docTitle: "offscreen-code.md",
  });

  const printed = job!.documentNode!;
  expect(printed.querySelector(".milkdown-code-block-placeholder")).toBeNull();
  expect(printed.querySelector(".codemirror-host > .cm-editor")).not.toBeNull();
  const lines = printed.querySelectorAll(".cm-content > .cm-line");
  expect(Array.from(lines, (line) => line.textContent)).toEqual(sourceLines);
  expect(lines[1]!.querySelector("br")).not.toBeNull();
  expect(printed.querySelector("tag")).toBeNull();
  const numbers = printed.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement");
  expect(Array.from(numbers, (cell) => cell.textContent)).toEqual(sourceLines.map((_, index) => String(index + 1)));
  expect(Array.from(numbers).every((cell) => cell.style.visibility !== "hidden")).toBe(true);
  expect(printed.querySelector("[contenteditable]")).toBeNull();
  expect(live.outerHTML).toBe(original);
  expect(destroy).toHaveBeenCalledOnce();
});
