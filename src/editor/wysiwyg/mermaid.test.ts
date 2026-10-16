// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Like Mermaid, the mock keeps the theme as global configuration and bakes it
// into each SVG.
const mermaid = vi.hoisted(() => {
  let theme = "";
  return {
    initialize: vi.fn((config: { theme: string }) => {
      theme = config.theme;
    }),
    parse: vi.fn(async (_code: string): Promise<boolean> => true),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}" data-theme="${theme}"></svg>` })),
  };
});
vi.mock("mermaid", () => ({ default: mermaid }));

import { renderMermaidPreview } from "./mermaid";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A code block's preview panel. Like Crepe, it shows a copy of each preview
 *  element's HTML, never the element itself. */
function previewPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const apply = vi.fn((value: null | string | HTMLElement) => {
    host.innerHTML = value instanceof HTMLElement ? value.outerHTML : (value ?? "");
  });
  return { host, apply };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-editor-theme");
  vi.clearAllMocks();
});

describe("renderMermaidPreview", () => {
  it("leaves other languages alone", () => {
    expect(renderMermaidPreview("ts", "const a = 1;", vi.fn())).toBeNull();
  });

  it("draws in the document theme and redraws when it changes", async () => {
    document.documentElement.dataset.editorTheme = "light";
    const { host, apply } = previewPanel();

    apply(renderMermaidPreview("mermaid", "graph LR\n  A --> B", apply));
    await settle();
    expect(host.querySelector("svg")?.dataset.theme).toBe("default");

    document.documentElement.dataset.editorTheme = "dark";
    await settle();
    expect(host.querySelector("svg")?.dataset.theme).toBe("dark");
    expect(apply).toHaveBeenCalledTimes(3);

    // A diagram that has left the page is not drawn again.
    host.remove();
    document.documentElement.dataset.editorTheme = "light";
    await settle();
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("names the diagram unless its source gives it a title", async () => {
    const plain = previewPanel();
    plain.apply(renderMermaidPreview("mermaid", "graph LR\n  A --> B", plain.apply));
    await settle();
    expect(plain.host.querySelector("svg")?.getAttribute("aria-label")).toBe("Mermaid diagram");

    // Mermaid names a diagram with an accTitle through aria-labelledby.
    mermaid.render.mockImplementationOnce(async (id: string) => ({
      svg: `<svg id="${id}" aria-labelledby="chart-title-${id}"><title id="chart-title-${id}">Flow</title></svg>`,
    }));
    const titled = previewPanel();
    titled.apply(renderMermaidPreview("mermaid", "graph LR\n  accTitle: Flow\n  A --> B", titled.apply));
    await settle();
    expect(titled.host.querySelector("svg")?.getAttribute("aria-labelledby")).toMatch(/^chart-title-/);
    expect(titled.host.querySelector("svg")?.hasAttribute("aria-label")).toBe(false);
  });

  it("shows only the newest render when the theme changes mid-render", async () => {
    document.documentElement.dataset.editorTheme = "light";
    const { host, apply } = previewPanel();
    let finishParse!: (ok: boolean) => void;
    mermaid.parse.mockImplementationOnce(() => new Promise((resolve) => (finishParse = resolve)));

    apply(renderMermaidPreview("mermaid", "graph LR\n  A --> B", apply));
    await settle();
    // The light render is still parsing when the document turns dark.
    document.documentElement.dataset.editorTheme = "dark";
    await settle();
    finishParse(true);
    await settle();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(host.querySelector("svg")?.dataset.theme).toBe("dark");
  });
});
