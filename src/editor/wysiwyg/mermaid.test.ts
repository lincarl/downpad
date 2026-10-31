// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMermaidPreview } from "./mermaid";

/** Resolve the actual renderer's final preview, as Crepe does after lazy loading. */
function preview(source: string): Promise<HTMLElement> {
  return new Promise((resolve) => {
    renderMermaidPreview("mermaid", source, (value) => {
      if (value instanceof HTMLElement) resolve(value);
    });
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderMermaidPreview", () => {
  it("leaves other languages and empty diagrams alone", () => {
    expect(renderMermaidPreview("ts", "const a = 1;", vi.fn())).toBeNull();
    expect(renderMermaidPreview("mermaid", " \n ", vi.fn())).toBeNull();
  });

  it.each([
    ["flowchart", "graph LR\nA[Draft] --> B[Ready]"],
    ["sequence", "sequenceDiagram\nAlice->>Bob: Hello"],
    ["class", "classDiagram\nAnimal <|-- Duck"],
  ])("renders %s diagrams with Pele and supplies an accessible name", async (_type, source) => {
    const element = await preview(source);
    expect(element.className).toBe("mermaid-preview");
    const drawing = element.querySelector("svg.pele");
    expect(drawing).not.toBeNull();
    expect(drawing?.getAttribute("aria-label")).toBe("Mermaid diagram");
    expect(drawing?.getAttribute("style")).toContain("var(--pele-fg");
  });

  it("preserves source titles with unique identifiers across diagrams", async () => {
    const source = "graph LR\naccTitle: Publishing flow\nA --> B";
    const first = await preview(source);
    const second = await preview(source);
    document.body.append(first, second);
    const firstTitle = first.querySelector("title")!;
    expect(firstTitle.textContent).toBe("Publishing flow");
    expect(first.querySelector("svg")?.getAttribute("aria-labelledby")).toBe(firstTitle.id);
    expect(second.querySelector("title")?.id).not.toBe(firstTitle.id);
    expect(first.querySelector("svg")?.hasAttribute("aria-label")).toBe(false);
  });

  it("keeps source links inert and labels as text", async () => {
    const element = await preview('graph LR\nA["<img src=x onerror=alert(1)>"] --> B\nclick B "https://example.test/"');
    expect(element.querySelector("svg.pele")).not.toBeNull();
    expect(element.querySelector("a, img, script, [onerror]")).toBeNull();
  });

  it("shows invalid source as an error and still renders the next diagram", async () => {
    const element = await preview('graph LR\nA["<img src=x onerror=alert(1)>');
    expect(element.className).toBe("mermaid-error");
    expect(element.textContent).toContain("Mermaid:");
    expect(element.childElementCount).toBe(0);
    expect((await preview("graph LR\nA --> B")).querySelector("svg.pele")).not.toBeNull();
  });
});
