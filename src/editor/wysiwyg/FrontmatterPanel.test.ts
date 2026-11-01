// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FrontmatterPanel,
  type FrontmatterFocus,
  type FrontmatterPanelProps,
} from "./FrontmatterPanel";

const YAML =
  "---\n" +
  "title: Welcome\n" +
  "tags: [demo, markdown]\n" +
  "metadata:\n" +
  "  category: demo\n" +
  "---\n";

afterEach(cleanup);

function rowFor(key: string): HTMLElement {
  const row = screen.getByRole("rowheader", { name: key }).closest("tr");
  if (!row) throw new Error(`No row for ${key}`);
  return row;
}

function valueFor(key: string): HTMLElement {
  const value = rowFor(key).querySelector<HTMLElement>(".frontmatter-value-edit");
  if (!value) throw new Error(`No editable value for ${key}`);
  return value;
}

/** Render the panel in a host that passes each published block and focus
 *  back in, as WysiwygEditor does. Returns every published block. */
function renderWithHost(block: string): string[] {
  const published: string[] = [];

  function Harness() {
    const [state, setState] = useState<{ block: string; focus: FrontmatterFocus }>({ block, focus: null });
    const onBlockChange: FrontmatterPanelProps["onBlockChange"] = (next, focus) => {
      published.push(next);
      setState({ block: next, focus: focus ?? null });
    };
    return createElement(FrontmatterPanel, { ...state, onBlockChange });
  }

  render(createElement(Harness));
  return published;
}

/** Press a button by its name, anywhere in the panel. */
const button = (name: string) => () => fireEvent.click(screen.getByRole("button", { name }));
/** Press Add field to this group in the row of `key`. */
const addToGroup = (key: string) => () =>
  fireEvent.click(within(rowFor(key)).getByRole("button", { name: "Add field to this group" }));

const rowHeaders = () => screen.getAllByRole("rowheader").map((cell) => cell.textContent);

describe("FrontmatterPanel", () => {
  it("preserves the table selectors and losslessly publishes key/value edits", () => {
    const onBlockChange = vi.fn<FrontmatterPanelProps["onBlockChange"]>();
    const { container } = render(
      createElement(FrontmatterPanel, { block: YAML, focus: null, onBlockChange }),
    );

    expect(screen.getByRole("table", { name: "Frontmatter" })).toBe(
      container.querySelector(".frontmatter-table"),
    );
    expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([
      "title",
      "tags",
      "metadata",
      "category",
    ]);

    const title = screen.getByRole("rowheader", { name: "title" });
    title.textContent = "heading";
    fireEvent.input(title);
    expect(onBlockChange).toHaveBeenLastCalledWith(
      YAML.replace("title: Welcome", "heading: Welcome"),
    );

    const nestedValue = valueFor("category");
    nestedValue.textContent = "notes";
    fireEvent.input(nestedValue);
    expect(onBlockChange).toHaveBeenLastCalledWith(
      YAML.replace("title: Welcome", "heading: Welcome").replace("  category: demo", "  category: notes"),
    );

    const tags = screen.getByRole("rowheader", { name: "tags" });
    tags.textContent = "ta:gs";
    fireEvent.input(tags);
    expect(tags.textContent).toBe("tags");
    expect(onBlockChange).toHaveBeenCalledTimes(2);

    expect(fireEvent.keyDown(nestedValue, { key: "Enter" })).toBe(false);
  });

  it("re-renders structural edits, focuses placeholders, and restores focus after delete", async () => {
    const published = renderWithHost(YAML);
    fireEvent.click(screen.getAllByRole("button", { name: /^Insert field/ })[1]);

    const placeholder = await screen.findByRole("rowheader", { name: "key" });
    expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([
      "title",
      "key",
      "tags",
      "metadata",
      "category",
    ]);
    expect(document.activeElement).toBe(placeholder);
    expect(published.at(-1)).toContain("title: Welcome\nkey: \ntags:");

    const placeholderRow = placeholder.closest("tr");
    if (!placeholderRow) throw new Error("Placeholder row is missing");
    fireEvent.click(within(placeholderRow).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add field" })));
    expect(screen.queryByRole("rowheader", { name: "key" })).toBeNull();
  });

  // Each case presses its controls in order. A second placeholder must not
  // repeat the first one's key, whichever control added it.
  it.each([
    {
      name: "the gap before the first field",
      block: YAML,
      presses: [button('Insert field before "title"'), button('Insert field before "title"')],
      keys: ["key", "key-2", "title", "tags", "metadata", "category"],
      published: "---\nkey: \nkey-2: \ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\n---\n",
    },
    {
      name: "the gap between two fields",
      block: YAML,
      presses: [button('Insert field before "tags"'), button('Insert field before "tags"')],
      keys: ["title", "key", "key-2", "tags", "metadata", "category"],
      published: "---\ntitle: Welcome\nkey: \nkey-2: \ntags: [demo, markdown]\nmetadata:\n  category: demo\n---\n",
    },
    {
      // A top-level field before the mapping, which keeps its child.
      name: "the gap before a mapping",
      block: YAML,
      presses: [button('Insert field before "metadata"'), button('Insert field before "metadata"')],
      keys: ["title", "tags", "key", "key-2", "metadata", "category"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nkey: \nkey-2: \nmetadata:\n  category: demo\n---\n",
    },
    {
      name: "the gap before a mapping's child",
      block: YAML,
      presses: [button('Insert field before "category"'), button('Insert field before "category"')],
      keys: ["title", "tags", "metadata", "key", "key-2", "category"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  key: \n  key-2: \n  category: demo\n---\n",
    },
    {
      name: "the gap at the end",
      block: YAML,
      presses: [button("Insert field at the end"), button("Insert field at the end")],
      keys: ["title", "tags", "metadata", "category", "key", "key-2"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\nkey: \nkey-2: \n---\n",
    },
    {
      name: "a mapping's Add field to this group",
      block: YAML,
      presses: [addToGroup("metadata"), addToGroup("metadata")],
      keys: ["title", "tags", "metadata", "category", "key", "key-2"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\n  key: \n  key-2: \n---\n",
    },
    {
      name: "a child's Add field to this group",
      block: YAML,
      presses: [addToGroup("category"), addToGroup("category")],
      keys: ["title", "tags", "metadata", "category", "key", "key-2"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\n  key: \n  key-2: \n---\n",
    },
    {
      name: "Add field",
      block: YAML,
      presses: [button("Add field"), button("Add field")],
      keys: ["title", "tags", "metadata", "category", "key", "key-2"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\nkey: \nkey-2: \n---\n",
    },
    {
      // Deleting every field leaves this block.
      name: "Add field in an empty block",
      block: "---\n---\n",
      presses: [button("Add field"), button("Add field")],
      keys: ["key", "key-2"],
      published: "---\nkey: \nkey-2: \n---\n",
    },
    {
      name: "Add field to this group, then Add field",
      block: YAML,
      presses: [addToGroup("metadata"), button("Add field")],
      keys: ["title", "tags", "metadata", "category", "key", "key-2"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\n  key: \nkey-2: \n---\n",
    },
    {
      name: "Add field, then Add field to this group",
      block: YAML,
      presses: [button("Add field"), addToGroup("category")],
      keys: ["title", "tags", "metadata", "category", "key-2", "key"],
      published: "---\ntitle: Welcome\ntags: [demo, markdown]\nmetadata:\n  category: demo\n  key-2: \nkey: \n---\n",
    },
  ])("$name inserts each new field at its line and indent with a new key", ({ block, presses, keys, published }) => {
    const blocks = renderWithHost(block);
    for (const press of presses) press();

    expect(blocks).toHaveLength(presses.length);
    expect(blocks.at(-1)).toBe(published);
    expect(rowHeaders()).toEqual(keys);
    expect(document.activeElement).toBe(screen.getByRole("rowheader", { name: "key-2" }));
    // The placeholder is selected, so the first key typed replaces it.
    expect(window.getSelection()?.toString()).toBe("key-2");
  });

  it("offers Add field to this group only on a mapping and its children", () => {
    render(createElement(FrontmatterPanel, { block: YAML, focus: null, onBlockChange: vi.fn() }));
    const actions = (key: string) =>
      within(rowFor(key)).getAllByRole("button").map((control) => control.getAttribute("aria-label"));

    expect(actions("title")).toEqual(["Delete"]);
    expect(actions("tags")).toEqual(["Delete"]);
    expect(actions("metadata")).toEqual(["Add field to this group", "Delete"]);
    expect(actions("category")).toEqual(["Add field to this group", "Delete"]);
  });

  // The panel writes a value as is into its one YAML line, so a line break in
  // a pasted value could end the frontmatter early.
  it("turns line breaks in a value into spaces before publishing it", () => {
    const onBlockChange = vi.fn<FrontmatterPanelProps["onBlockChange"]>();
    render(createElement(FrontmatterPanel, { block: YAML, focus: null, onBlockChange }));

    const title = valueFor("title");
    title.textContent = "a\r\n---\nb";
    fireEvent.input(title);

    expect(title.textContent).toBe("a --- b");
    expect(onBlockChange).toHaveBeenLastCalledWith(YAML.replace("title: Welcome", "title: a --- b"));
  });

  it("keeps an unsupported comments-only block read-only", () => {
    const { container } = render(
      createElement(FrontmatterPanel, {
        block: "---\n# authored note\n---\n",
        focus: null,
        onBlockChange: vi.fn(),
      }),
    );

    expect(container.querySelector(".frontmatter-raw .frontmatter-code")?.textContent).toBe(
      "# authored note",
    );
    expect(screen.queryByText("Frontmatter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
  });
});
