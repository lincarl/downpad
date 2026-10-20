// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { RawEditor, dropEditChanges } from "./RawEditor";
import type { SourceEdit } from "../wysiwyg/fileDrop";

const editors: RawEditor[] = [];

/** Mount a Markdown pane holding `before` and `after`, with the caret between. */
function mountWithCaret(before: string, after = ""): RawEditor {
  const editor = new RawEditor();
  editor.mount(document.createElement("div"), after, { onChange: () => {} });
  editor.insertText(before);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

/** Type `text` over the selection, as a key press does. */
function typeOver(editor: RawEditor, text: string): void {
  const { view } = editor as unknown as { view: EditorView };
  view.dispatch(view.state.replaceSelection(text));
}

const FIND = { caseSensitive: true, wholeWord: false, regex: false };

describe("RawEditor.insertText", () => {
  it("puts a dropped file after the selected text, such as the find card's match, not over it", () => {
    const editor = mountWithCaret("", "First line.\n");
    editor.searchText("line", FIND);

    editor.insertText("[a.csv](attachments/a.csv)");
    typeOver(editor, "!");

    expect(editor.getText()).toBe("First line[a.csv](attachments/a.csv)!.\n");
  });

  it("leaves the selection as it was, without the file, for a user who has moved on", () => {
    const editor = mountWithCaret("", "First line.\n");
    editor.searchText("line", FIND);

    editor.insertText("[a.csv](attachments/a.csv)", null, false);
    typeOver(editor, "!");

    expect(editor.getText()).toBe("First ![a.csv](attachments/a.csv).\n");
  });

  it("keeps the files of one drop at the caret in drop order, for a user who has moved on", () => {
    const editor = mountWithCaret("First line.", "\nSecond line.\n");

    const next = editor.insertText("[a.csv](attachments/a.csv)", null, false);
    editor.insertText("[b.csv](attachments/b.csv)", next, false);
    typeOver(editor, "!");

    expect(editor.getText()).toBe("First line.![a.csv](attachments/a.csv)[b.csv](attachments/b.csv)\nSecond line.\n");
  });

  it("puts a file in as an undo step of its own, apart from the typing right before and after it", () => {
    const editor = mountWithCaret("First line.", "\n");
    const { view } = editor as unknown as { view: EditorView };
    const typeKeys = (text: string): void => view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.type" });

    typeKeys(" Typed.");
    editor.insertText("![](attachments/a.png)", null, false);
    typeKeys(" More.");

    undo(view);
    expect(editor.getText()).toBe("First line. Typed.![](attachments/a.png)\n");
    undo(view);
    expect(editor.getText()).toBe("First line. Typed.\n");
  });
});

describe("RawEditor.blockTargetAtCaret", () => {
  const IMAGE = "![](attachments/a.png)";

  it.each([
    ["a heading the text starts with", "", "# Title\n\nFirst line.\n", `# Title\n\n${IMAGE}\n\nFirst line.\n`],
    ["the frontmatter", "", "---\ntitle: Notes\n---\n\nFirst line.\n", `---\ntitle: Notes\n---\n\n${IMAGE}\n\nFirst line.\n`],
    ["the middle of a line", "First", " line.\n\nSecond line.\n", `First line.\n\n${IMAGE}\n\nSecond line.\n`],
    ["the end of a list", "- One\n- Two", "\n\nAfter.\n", `- One\n- Two\n\n${IMAGE}\n\nAfter.\n`],
    ["a code fence not closed yet", "First line.\n\n```js\ncode", "", `First line.\n\n${IMAGE}\n\n\`\`\`js\ncode`],
    ["display math with a blank line", "First line.\n\n$$\na+b", "\n\nc+d\n$$\n\nAfter.\n", `First line.\n\n$$\na+b\n\nc+d\n$$\n\n${IMAGE}\n\nAfter.\n`],
    ["display math right below a paragraph's line", "Intro.\n$$\na+b", "\n\nc+d\n$$\nAfter.\n", `Intro.\n$$\na+b\n\nc+d\n$$\n\n${IMAGE}\n\nAfter.\n`],
    ["display math not closed yet", "First line.\n\n$$\na+b", "\n\nc+d\n", `First line.\n\n${IMAGE}\n\n$$\na+b\n\nc+d\n`],
  ])("puts a file in after the block that holds a caret in %s, as a paragraph of its own", (_where, before, after, expected) => {
    const editor = mountWithCaret(before, after);

    const target = editor.blockTargetAtCaret()!;
    editor.insertText(IMAGE, target, false);

    expect(editor.getText()).toBe(expected);
  });
});

describe("RawEditor.applyDropEdit", () => {
  const LINK = "[a.csv](attachments/a.csv)";

  it("keeps the caret where the user types, on either side of the file", () => {
    // Typing at the end of the line the file goes in after.
    const end = mountWithCaret("First line.", "\n\nSecond line.\n");
    end.applyDropEdit({ from: 11, to: 11, insert: `\n\n${LINK}`, assoc: -1 });
    end.insertText(" Typed.");
    expect(end.getText()).toBe(`First line. Typed.\n\n${LINK}\n\nSecond line.\n`);

    // Typing at the start of the first line, which the file goes in before.
    const start = mountWithCaret("", "First line.\n");
    start.applyDropEdit({ from: 0, to: 0, insert: `${LINK}\n\n`, assoc: 1 });
    start.insertText("Typed. ");
    expect(start.getText()).toBe(`${LINK}\n\nTyped. First line.\n`);
  });

  it("replaces only the part of a rewritten block that changed, so a caret in it keeps its place", () => {
    const editor = mountWithCaret("- a", "\n- b\n");

    editor.applyDropEdit({ from: 0, to: 7, insert: `- a\n- ${LINK}\n- b`, assoc: -1 });
    editor.insertText("x");

    expect(editor.getText()).toBe(`- ax\n- ${LINK}\n- b\n`);
  });

  it.each([
    ["at the start of its text", "1. One\n2. ", "Two\n3. Three\n", `1. One\n2. ${LINK}\n3. XTwo\n4. Three\n`],
    ["at the start of its line", "1. One\n", "2. Two\n3. Three\n", `1. One\n2. ${LINK}\nX3. Two\n4. Three\n`],
    ["at the start of a bulleted item's text", "- One\n- ", "Two\n- Three\n", `- One\n- ${LINK}\n- XTwo\n- Three\n`],
  ])("keeps a caret before the text of the item the file goes in before with that text, %s", (_where, before, after, expected) => {
    const editor = mountWithCaret(before, after);
    const insert = expected.replace("X", "").trimEnd();

    editor.applyDropEdit({ from: 0, to: before.length + after.length - 1, insert, assoc: -1 });
    editor.insertText("X");

    expect(editor.getText()).toBe(expected);
  });

  it("keeps a caret in a list item that the file only renumbers", () => {
    const editor = mountWithCaret("1. One\n2. Two\n3. Th", "ree\n4. Four\n");

    editor.applyDropEdit({ from: 0, to: 30, insert: `1. One\n2. ${LINK}\n3. Two\n4. Three\n5. Four`, assoc: -1 });
    editor.insertText("X");

    expect(editor.getText()).toBe(`1. One\n2. ${LINK}\n3. Two\n4. ThXree\n5. Four\n`);
  });

  // An image dropped beside an item's text goes into that item as its second
  // block, after a blank line. The document view writes an empty item as "<br />".
  it.each([
    ["into the item before it, at the end of a numbered list", "1. One\n2. Two\n3. ", "", "1. One\n2. Two\n\n   ![](a.png)\n3. <br />"],
    ["into the item before it, at the end of a bulleted list", "- Alpha\n- Beta\n- ", "", "- Alpha\n- Beta\n\n  ![](a.png)\n- <br />"],
    ["into the item before it, mid-list", "- Alpha\n- ", "\n- Gamma", "- Alpha\n\n  ![](a.png)\n- <br />\n- Gamma"],
    ["into it", "- Alpha\n- ", "\n- Gamma", "- Alpha\n- <br />\n\n  ![](a.png)\n- Gamma"],
    ["as an item before it", "- Alpha\n- ", "\n- Gamma", `- Alpha\n- ${LINK}\n- <br />\n- Gamma`],
    ["into the item before it, at the end of a list in a quote", "> - Alpha\n> - Beta\n> - ", "", "> - Alpha\n> - Beta\n>\n>   ![](a.png)\n> - <br />"],
    ["into the item before it, mid-list in a quote", "> - Alpha\n> - ", "\n> - Gamma", "> - Alpha\n>\n>   ![](a.png)\n> - <br />\n> - Gamma"],
  ])("keeps a caret in an empty item, which the document view writes as <br />, when the file goes %s", (_where, before, after, insert) => {
    const editor = mountWithCaret(before, after);

    editor.applyDropEdit({ from: 0, to: before.length + after.length, insert, assoc: -1 });
    editor.insertText("X");

    expect(editor.getText()).toBe(insert.replace("<br />", "X<br />"));
  });

  // The document view writes the list another way, such as with escapes,
  // without trailing spaces or with an entity decoded, also in the lines next
  // to the file.
  it.each([
    ["at the start of an item's text that gets an escape", "- One\n- ", "price * qty\n- Three", `- One\n- ${LINK}\n- Xprice \\* qty\n- Three`],
    ["in an item's text without its trailing space", "1. One\n2. Tw", "o \n3. Three", `1. One\n2. ${LINK}\n3. TwXo\n4. Three`],
    ["between escapes", "1. One\n2. a * ", "b * c\n3. Three", `1. One\n2. ${LINK}\n3. a \\* Xb \\* c\n4. Three`],
    ["before an escape", "1. One\n2. a ", "* b * c\n3. Three", `1. One\n2. ${LINK}\n3. a X\\* b \\* c\n4. Three`],
    ["at the start of an item's text that gets escapes", "1. One\n2. ", "a * b * c\n3. Three", `1. One\n2. ${LINK}\n3. Xa \\* b \\* c\n4. Three`],
    ["in the item before the file", "- One * t", "wo \n- Three", `- One \\* tXwo\n- ${LINK}\n- Three`],
    ["at the start of an item's text whose entity the document view decodes", "- One\n- ", "&amp; more\n- Three", `- One\n- ${LINK}\n- X& more\n- Three`],
  ])("keeps a caret %s, next to the file, before the same character", (_where, before, after, expected) => {
    const editor = mountWithCaret(before, after);

    editor.applyDropEdit({ from: 0, to: before.length + after.length, insert: expected.replace("X", ""), assoc: -1 });
    editor.insertText("X");

    expect(editor.getText()).toBe(expected);
  });

  it("keeps a caret in a long list whose every item the document view writes with an escape", () => {
    const items = Array.from({ length: 80 }, (_item, index) => `item_${index}`);
    const escaped = items.map((item) => item.replace("_", "\\_"));
    const editor = mountWithCaret(`- ${items.slice(0, 41).join("\n- ")}`, `\n- ${items.slice(41).join("\n- ")}`);
    const insert = `- ${[...escaped.slice(0, 40), LINK, ...escaped.slice(40)].join("\n- ")}`;

    editor.applyDropEdit({ from: 0, to: editor.getText().length, insert, assoc: -1 });
    editor.insertText("X");

    expect(editor.getText()).toBe(insert.replace("item\\_40", "item\\_40X"));
  });

  /** Put `text` in the pane with the caret at `caret`, make a drop's `edit`,
   *  and type X. */
  function typeAfterDrop(editor: RawEditor, text: string, caret: number, edit: SourceEdit): string {
    const { view } = editor as unknown as { view: EditorView };
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: caret } });
    editor.applyDropEdit(edit);
    editor.insertText("X");
    return editor.getText();
  }

  // Item texts and file names whose characters the link and the item share,
  // which a diff of characters matched up across them.
  const ITEMS = ["two", "Two", "apples", "call mom", "eggs", "tea", "notes", "see this", "milk", "task", "next step"];
  const FILES = ["notes.csv", "report.pdf", "Two.csv", "data.csv"];

  it.each(ITEMS.flatMap((item) => FILES.map((file) => [item, file])))(
    "keeps a caret in the item %j, numbered or bulleted, in its place when %s goes in before it",
    (item, file) => {
      const editor = mountWithCaret("");
      const link = `[${file}](attachments/${file})`;
      for (const marker of [(n: number) => `${n}. `, () => "- "]) {
        const list = (texts: string[]): string => texts.map((text, index) => marker(index + 1) + text).join("\n");
        const before = list(["One", item, "later item"]);
        const after = list(["One", link, item, "later item"]);
        // Where column `column` of the text of line `line` is, or the line's start for null.
        const offset = (text: string, line: number, column: number | null): number =>
          text.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0) + (column === null ? 0 : marker(line + 1).length + column);
        // The item and the one after it, at the start of the line and of the
        // text, in the middle of the text and at its end.
        for (const [line, column] of [[1, null], [1, 0], [1, 2], [1, item.length], [2, null], [2, 0], [2, 5]] as const) {
          const typed = typeAfterDrop(editor, before, offset(before, line, column), { from: 0, to: before.length, insert: after, assoc: -1 });
          const at = offset(after, line + 1, column);
          expect(typed, `${marker(1)}line ${line}, column ${column}`).toBe(after.slice(0, at) + "X" + after.slice(at));
        }
      }
    },
  );
});

describe("dropEditChanges", () => {
  /** A generator of numbers from 0 up to 1 with a fixed seed (mulberry32), so
   *  a failing list comes back the same. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Item texts that share characters with the links that go in, some that
  // start like a marker, some that the document view writes another way, and
  // one that is empty.
  const TEXTS = [
    "notes", "notes.csv", "Two", "two", "attachments", "attach ments", "csv", "a", "t", "tea", "apples", "report",
    "data", "see [this](that)", "(paren)", "[bracket]", "1. not a marker", "2) not one either", "- dash", "+ plus",
    "10 apples", "", "trailing ", "\u{1F600} smile", "back\\slash", "under_score", "*stars*", "x](y",
    "price * qty", "a * b * c", "snake_case_name", "two spaces  ", "*", "_", "a_b ", "fish &amp; chips",
  ];
  const FILES = ["notes.csv", "report.pdf", "Two.csv", "data.csv", "a", "my notes (1).txt", "1. list.md", "\u{1F600}.txt", "attachments.zip", "apples"];

  interface Item {
    depth: number;
    text: string;
    /** The mark in a task item's box. */
    task?: string;
  }

  /** How the list at a depth is written: with `bullet`, or numbered from
   *  `start` with `delimiter`. */
  interface Style {
    bullet?: string;
    delimiter: string;
    start: number;
  }

  /** A line of a list as its indentation, the part before its text, the
   *  text, and the indentation of the item's later blocks. */
  interface Line {
    indent: number;
    prefix: string;
    text: string;
    content: number;
  }

  /** The lines of a list. Each nested list is indented to its parent's text. */
  function writeList(items: Item[], styles: Style[]): Line[] {
    const numbers: number[] = [];
    const widths: number[] = [];
    return items.map(({ depth, text, task }) => {
      numbers.length = depth + 1;
      widths.length = depth;
      const style = styles[depth];
      numbers[depth] = (numbers[depth] ?? style.start - 1) + 1;
      const indent = depth === 0 ? 0 : widths[depth - 1];
      const marker = style.bullet ?? `${numbers[depth]}${style.delimiter}`;
      widths[depth] = indent + marker.length + 1;
      return { indent, prefix: `${" ".repeat(indent)}${marker} ${task ? `[${task}] ` : ""}`, text, content: widths[depth] };
    });
  }

  /** The document view's form of an item's text, with "*" and "_" escaped,
   *  "&amp;" written as "&" and trailing spaces dropped, and where each column
   *  of the text goes: before the same character, with its escape, or after
   *  the "&" of the entity it is in. */
  function rewrite(text: string): { text: string; columns: number[] } {
    const kept = text.replace(/[ \t]+$/, "").length;
    let written = "";
    const columns = [0];
    for (let index = 0; index < text.length; index += 1) {
      const entity = text.lastIndexOf("&amp;", index);
      if (entity >= 0 && index < entity + 5) written += index === entity ? "&" : "";
      else if (index < kept) written += "*_".includes(text[index]) ? `\\${text[index]}` : text[index];
      columns.push(written.length);
    }
    return { text: written, columns };
  }

  /** Whether a line is an empty item, which the document view writes as "<br />". */
  const isEmpty = (line: Line): boolean => line.text === "" || line.text === "<br />";

  it("keeps every caret in a line whose text stays before the same character of that text, or in the same empty item", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 3000; seed += 1) {
      const random = seeded(seed);
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
      const styles: Style[] = [0, 1, 2].map(() =>
        random() < 0.5 ? { bullet: pick(["-", "*", "+"]), delimiter: ".", start: 1 } : { delimiter: pick([".", ")"]), start: pick([1, 0, 3, 8, 9, 98, 99]) },
      );
      // The document view can write the markers another way.
      const newStyles = styles.map((style) =>
        random() < 0.3 ? (style.bullet ? { ...style, bullet: pick(["-", "*", "+"]) } : { ...style, delimiter: pick([".", ")"]) }) : style,
      );
      // Unless another line changes too, items can share a text, and some
      // are empty, as just typed. Otherwise they are drawn from the texts
      // shuffled.
      const variant = pick(["insert", "insert", "insert", "change", "remove"]);
      const texts = variant === "insert" ? [] : [...TEXTS];
      for (let index = texts.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [texts[index], texts[other]] = [texts[other], texts[index]];
      }
      const items: Item[] = [];
      for (let index = 0, count = 1 + Math.floor(random() * 7); index < count; index += 1) {
        const depth = index === 0 ? 0 : Math.min(2, Math.floor(random() * (items[index - 1].depth + 2)));
        const text = variant === "insert" && random() < 0.2 ? "" : (texts.pop() ?? pick(TEXTS));
        items.push({ depth, text, ...(random() < 0.15 ? { task: pick([" ", "x"]) } : {}) });
      }
      // The item that also changes or goes, if any.
      const other = variant === "insert" ? -1 : Math.floor(random() * items.length);
      // The file goes in as an item at a depth that fits between its
      // neighbors, or an image as the second block of the item before, after
      // a blank line, as the document view puts an image beside that item's text.
      const at = Math.floor(random() * (items.length + 1));
      const image = at > 0 && !(variant === "remove" && other === at - 1) && random() < 0.3;
      const lowest = at < items.length ? Math.max(0, items[at].depth - 1) : 0;
      const highest = at > 0 ? Math.min(2, items[at - 1].depth + 1) : 0;
      const file = pick(FILES);
      const link: Item = { depth: lowest + Math.floor(random() * (highest - lowest + 1)), text: `[${file}](attachments/${encodeURI(file)})` };
      const newItems = image ? [...items] : [...items.slice(0, at), link, ...items.slice(at)];
      // The line each line went to.
      let moved = items.map((_item, index) => (index < at || image ? index : index + 1));
      if (variant === "change") newItems[moved[other]] = { ...items[other], text: `${items[other].text}!` };
      if (variant === "remove") {
        newItems.splice(moved[other], 1);
        for (let index = other + 1; index < moved.length; index += 1) moved[index] -= 1;
        // Items nested under the one that went join the list around it.
        newItems.forEach((item, index) => {
          newItems[index] = { ...item, depth: Math.min(item.depth, index === 0 ? 0 : newItems[index - 1].depth + 1) };
        });
      }

      // An empty item can be written "<br />", before and after.
      const emptyAs = (text: string) => (line: Line): Line => (line.text === "" ? { ...line, text } : line);
      const lines = writeList(items, styles).map(emptyAs(random() < 0.25 ? "<br />" : ""));
      const newLines = writeList(newItems, newStyles).map(emptyAs(random() < 0.6 ? "<br />" : ""));
      if (image) {
        const holder = moved[at - 1];
        const { content } = newLines[holder];
        const blank = { indent: 0, prefix: "", text: "", content: 0 };
        newLines.splice(holder + 1, 0, blank, { indent: content, prefix: " ".repeat(content), text: `![](attachments/${encodeURI(file)})`, content });
        moved = moved.map((line) => (line > holder ? line + 2 : line));
      }
      // The document view writes some items another way, mostly those next
      // to the file. Where each column of their text goes.
      const columns = lines.map((_line, index) => {
        const newLine = newLines[moved[index]];
        const next = index === at - 1 || index === at;
        if (index === other || isEmpty(newLine) || random() >= (next ? 0.7 : 0.1)) return null;
        const written = rewrite(newLine.text);
        newLines[moved[index]] = { ...newLine, text: written.text };
        return written.columns;
      });
      const write = (list: Line[]): string => list.map((line) => line.prefix + line.text).join("\n");
      const intro = "Intro text.\n\n";
      const source = `${intro}${write(lines)}\n\nEnd text.\n`;
      const changed = `${intro}${write(newLines)}\n\nEnd text.\n`;
      const doc = Text.of(source.split("\n"));
      const edit: SourceEdit = { from: intro.length, to: intro.length + write(lines).length, insert: write(newLines), assoc: -1 };
      const { changes, mapPos } = dropEditChanges(doc, edit);
      const result = changes.apply(doc).toString();
      if (result !== changed) failures.push(`seed ${seed}: text ${JSON.stringify(result)}, not ${JSON.stringify(changed)}`);

      // Where each line starts, before and after.
      const startOf = (list: Line[], index: number): number =>
        intro.length + list.slice(0, index).reduce((sum, line) => sum + line.prefix.length + line.text.length + 1, 0);
      // Check that `pos` goes to `lowest`, or anywhere up to `highest`.
      const check = (pos: number, lowest: number, highest = lowest): void => {
        const got = mapPos(pos);
        if (got < lowest || got > highest) {
          const show = (text: string, at: number) => JSON.stringify(`${text.slice(text.lastIndexOf("\n", at - 1) + 1, at)}|${text.slice(at, text.indexOf("\n", at))}`);
          failures.push(`seed ${seed}: ${show(source, pos)} went to ${show(result, got)}, not ${show(result, lowest)}`);
        }
      };
      lines.forEach((line, index) => {
        if (index === other) return;
        const newLine = newLines[moved[index]];
        const start = startOf(lines, index);
        const newStart = startOf(newLines, moved[index]);
        // The start of the line, before its marker, and before the space
        // after the marker, which stays as far from the text.
        check(start, newStart);
        check(start + line.indent, newStart + newLine.indent);
        check(start + line.prefix.length - 1, newStart + newLine.prefix.length - 1);
        // The start of the text, its middle (between whole characters), and
        // its end. A caret in an empty item stays in it.
        const text = start + line.prefix.length;
        const newText = newStart + newLine.prefix.length;
        let middle = Math.floor(line.text.length / 2);
        if (/[\uDC00-\uDFFF]/.test(line.text.charAt(middle))) middle -= 1;
        for (const column of [0, middle, line.text.length]) {
          if (isEmpty(line) && isEmpty(newLine)) check(text + column, newText, newText + newLine.text.length);
          else check(text + column, newText + (columns[index]?.[column] ?? column));
        }
      });
      // Around the list.
      check(3, 3);
      check(source.length - 4, result.length - 4);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe("RawEditor.setText", () => {
  it.each([
    ["adds text before it", "First line.", "![](a.png)\n\nFirst line.\n", "![](a.png)\n\nFirst line. Typed.\n"],
    ["adds text after it", "First line.", "First line.\n\n![](a.png)\n", "First line. Typed.\n\n![](a.png)\n"],
    ["removes text before it", "Intro.\n\nFirst line.", "First line.\n", "First line. Typed.\n"],
  ])("keeps the caret in place when the other pane %s", (_change, beforeCaret, mirrored, typed) => {
    const editor = mountWithCaret(beforeCaret, "\n");

    editor.setText(mirrored);
    editor.insertText(" Typed.");

    expect(editor.getText()).toBe(typed);
  });

  // The document pane's report can change several places at once. Its first
  // edit writes these bullets in its own form, and Replace all changes every match.
  it.each([
    [
      "an edit that rewrites the source",
      "* Alpha\n* Beta\n\nFirst line.\n\nSecond line.\n\nThird line.\n\n* Gamma\n* Delta\n",
      "- Alpha\n- Beta\n\nFirst line.\n\nSecond line.\n\nThird line.X\n\n- Gamma\n- Delta\n",
    ],
    ["Replace all", "Alpha word.\n\nFirst line.\n\nSecond line.\n\nOmega word.\n", "Alpha term.\n\nFirst line.\n\nSecond line.\n\nOmega term.\n"],
  ])("keeps a drop's place and the caret between the places %s changed", (_change, text, mirrored) => {
    const editor = mountWithCaret("", text);
    const { view } = editor as unknown as { view: EditorView };
    const lineEnd = text.indexOf("First line.") + "First line.".length;
    vi.spyOn(view, "posAtCoords").mockReturnValue(lineEnd);
    const target = editor.dropTargetAt(10, 10);
    view.dispatch({ selection: { anchor: text.indexOf("Second line.") + "Second".length } });

    editor.setText(mirrored);
    editor.insertText("[n.csv](attachments/n.csv)", target, false);
    typeOver(editor, "!");

    expect(editor.getText()).toBe(mirrored.replace("First line.", "First line.[n.csv](attachments/n.csv)").replace("Second line.", "Second! line."));
  });

  it("moves a caret inside the change before a whole emoji, not between its halves", () => {
    // U+1F600 and U+1F601 share their first UTF-16 unit.
    const editor = mountWithCaret("\u{1F600}abc", "def");

    editor.setText("\u{1F601}abcdeg");
    editor.insertText("X");

    expect(editor.getText()).toBe("X\u{1F601}abcdeg");
  });

  it("moves a selection that starts inside the change after a whole emoji", () => {
    const editor = mountWithCaret("", "ab\u{1F600}yz");
    // Select "b", the emoji and "y". The find card is one way to select.
    editor.searchText("b\u{1F600}y", FIND);

    // U+1F600 and U+1F200 share their second UTF-16 unit.
    editor.setText("cd\u{1F200}yz");
    typeOver(editor, "X");

    expect(editor.getText()).toBe("cd\u{1F200}Xz");
  });

  it.each([
    ["abcabc", "abc"],
    ["abc", "abcabc"],
    ["aaa", "aa"],
    ["- a\n- b\n", "* a\n* b\n"],
    ["", "text"],
    ["text", ""],
  ])("turns %j into %j", (before, after) => {
    const editor = mountWithCaret(before);

    editor.setText(after);

    expect(editor.getText()).toBe(after);
  });
});
