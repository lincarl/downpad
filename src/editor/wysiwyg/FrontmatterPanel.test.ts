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

function valueFor(key: string): HTMLElement {
  const row = screen.getByRole("rowheader", { name: key }).closest("tr");
  if (!row) throw new Error(`No row for ${key}`);
  const value = row.querySelector<HTMLElement>(".frontmatter-value-edit");
  if (!value) throw new Error(`No editable value for ${key}`);
  return value;
}

describe("FrontmatterPanel", () => {
  it("preserves the table selectors and losslessly publishes key/value edits", () => {
    const onBlockChange = vi.fn<FrontmatterPanelProps["onBlockChange"]>();
    const { container } = render(
      createElement(FrontmatterPanel, { block: YAML, focus: null, onBlockChange }),
    );

    expect(container.querySelector(".frontmatter-table caption .frontmatter-tab")?.textContent).toBe(
      "Frontmatter",
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
    const published: string[] = [];

    function Harness() {
      const [state, setState] = useState<{ block: string; focus: FrontmatterFocus }>({
        block: YAML,
        focus: null,
      });
      const onBlockChange: FrontmatterPanelProps["onBlockChange"] = (block, focus) => {
        published.push(block);
        setState({ block, focus: focus ?? null });
      };
      return createElement(FrontmatterPanel, { ...state, onBlockChange });
    }

    render(createElement(Harness));
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
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
  });
});
