// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrontmatterDisclosure } from "./FrontmatterDisclosure";
import { FrontmatterPanel } from "./FrontmatterPanel";

const YAML = "---\ntitle: Welcome\nmetadata:\n  category: notes\n  draft: true\ntags:\n  - markdown\n---\n";

afterEach(cleanup);

/** Render a controlled disclosure with a tab stop before and after its content. */
function Harness({ initiallyExpanded = false }: { initiallyExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <>
      <FrontmatterDisclosure block={YAML} expanded={expanded} onExpandedChange={setExpanded}>
        <input aria-label="Frontmatter value" defaultValue="Welcome" />
      </FrontmatterDisclosure>
      <input aria-label="Find in document" />
    </>
  );
}

describe("FrontmatterDisclosure", () => {
  it.each([
    [YAML, "Frontmatter 3 fields"],
    ["---\ntitle: Welcome\n---\n", "Frontmatter 1 field"],
    ["---\n---\n", "Frontmatter 0 fields"],
    ["---\n \n\n---\n", "Frontmatter 0 fields"],
    ["---\n# authored note\n---\n", "Frontmatter"],
    ["---\n- first\n- second\n---\n", "Frontmatter"],
    ["---\nplain text\n---\n", "Frontmatter"],
    ["---\ntitle: Welcome\n- unsupported\n---\n", "Frontmatter"],
  ])("labels the top-level fields in %j as %s", (block, name) => {
    render(
      <FrontmatterDisclosure block={block} expanded={false} onExpandedChange={vi.fn()}>
        <span>Content</span>
      </FrontmatterDisclosure>,
    );
    expect(screen.getByRole("button", { name }).textContent).toBe(name);
  });

  it("requests controlled changes without editing or unmounting the table", () => {
    const onExpandedChange = vi.fn();
    const onBlockChange = vi.fn();
    const panel = <FrontmatterPanel block={YAML} focus={null} onBlockChange={onBlockChange} />;
    const view = (expanded: boolean) => (
      <FrontmatterDisclosure block={YAML} expanded={expanded} onExpandedChange={onExpandedChange}>
        {panel}
      </FrontmatterDisclosure>
    );
    const { container, rerender } = render(view(false));
    const toggle = screen.getByRole("button", { name: "Frontmatter 3 fields" });
    const contentId = toggle.getAttribute("aria-controls");
    const content = contentId ? document.getElementById(contentId) : null;
    const table = container.querySelector(".frontmatter-table");
    expect(content).not.toBeNull();
    expect(content?.hidden).toBe(true);
    expect(toggle.nextElementSibling).toBe(content);
    expect(content?.contains(table)).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content?.hidden).toBe(true);

    rerender(view(true));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content?.hidden).toBe(false);
    expect(screen.getByRole("table", { name: "Frontmatter" })).toBe(table);
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);

    rerender(view(false));
    expect(content?.hidden).toBe(true);
    expect(container.querySelector(".frontmatter-table")).toBe(table);
    expect(onBlockChange).not.toHaveBeenCalled();
  });

  it("preserves the toggle and content ID when the keyed panel changes", () => {
    const onExpandedChange = vi.fn();
    const view = (block: string, tableKey: number) => (
      <FrontmatterDisclosure block={block} expanded={true} onExpandedChange={onExpandedChange}>
        <FrontmatterPanel key={tableKey} block={block} focus={null} onBlockChange={vi.fn()} />
      </FrontmatterDisclosure>
    );
    const { rerender } = render(view(YAML, 1));
    const toggle = screen.getByRole("button", { name: "Frontmatter 3 fields" });
    const contentId = toggle.getAttribute("aria-controls");
    const originalTable = screen.getByRole("table", { name: "Frontmatter" });
    toggle.focus();

    rerender(view("---\ntitle: Changed\n---\n", 2));
    expect(screen.getByRole("button", { name: "Frontmatter 1 field" })).toBe(toggle);
    expect(toggle.getAttribute("aria-controls")).toBe(contentId);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole("table", { name: "Frontmatter" })).not.toBe(originalTable);
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("uses separate content IDs for separate disclosures", () => {
    const { container } = render(
      <>
        <Harness />
        <Harness />
      </>,
    );
    const controls = screen.getAllByRole("button").map((button) => button.getAttribute("aria-controls"));
    expect(new Set(controls).size).toBe(2);
    expect(Array.from(container.querySelectorAll(".frontmatter-content"), (content) => content.id)).toEqual(controls);
  });

  it("supports native Enter and Space activation and skips collapsed content in tab order", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Frontmatter 3 fields" });
    const find = screen.getByRole("textbox", { name: "Find in document" });
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.tab();
    expect(document.activeElement).toBe(find);
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Frontmatter value" }));
    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.tab();
    expect(document.activeElement).toBe(find);
  });

  it("closes from content on Escape and returns focus without handling external Escape", async () => {
    const user = userEvent.setup();
    render(<Harness initiallyExpanded />);
    const toggle = screen.getByRole("button", { name: "Frontmatter 3 fields" });
    const find = screen.getByRole("textbox", { name: "Find in document" });
    const value = screen.getByRole("textbox", { name: "Frontmatter value" });
    await user.click(find);
    expect(fireEvent.keyDown(find, { key: "Escape" })).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(find);

    await user.click(value);
    expect(fireEvent.keyDown(value, { key: "Escape", isComposing: true })).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fireEvent.keyDown(value, { key: "Escape" })).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Frontmatter value" })).toBe(value);
  });
});
