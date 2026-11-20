import { describe, expect, it } from "vitest";
import { blankDoc, isRecoveredDocument, lacksSavedText, type DocumentState } from "./types";

/** A document of a file that Downpad read, with `changes` on top. */
function fileDoc(changes: Partial<DocumentState> = {}): DocumentState {
  return { ...blankDoc(), markdown: "Text.\n", savedMarkdown: "Text.\n", filePath: "/notes/notes.md", fileSize: 6, ...changes };
}

describe("lacksSavedText", () => {
  it("holds for unsaved text over a file that was read and has no saved text now", () => {
    expect(lacksSavedText(fileDoc({ isDirty: true, savedMarkdown: null }))).toBe(true);
  });

  it("does not hold for a saved document, an unsaved one with its saved text, an untitled one or a recovered one", () => {
    expect(lacksSavedText(fileDoc())).toBe(false);
    expect(lacksSavedText(fileDoc({ isDirty: true, markdown: "More.\n" }))).toBe(false);
    expect(lacksSavedText({ ...blankDoc(), isDirty: true, savedMarkdown: null })).toBe(false);
    const recovered = fileDoc({ isDirty: true, savedMarkdown: null, fileSize: undefined });
    expect(isRecoveredDocument(recovered)).toBe(true);
    expect(lacksSavedText(recovered)).toBe(false);
  });
});
