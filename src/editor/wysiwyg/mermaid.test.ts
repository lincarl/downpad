// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => true),
  render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

import { renderMermaidPreview } from "./mermaid";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    const host = document.createElement("div");
    document.body.append(host);
    const apply = vi.fn((value: null | string | HTMLElement) => {
      host.replaceChildren(...(value instanceof HTMLElement ? [value] : []));
    });

    const loading = renderMermaidPreview("mermaid", "graph LR\n  A --> B", apply);
    host.append(loading!);
    await settle();
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
    expect(apply).toHaveBeenCalledTimes(1);

    document.documentElement.dataset.editorTheme = "dark";
    await settle();
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(apply).toHaveBeenCalledTimes(2);

    // A diagram that has left the page is not drawn again.
    host.remove();
    document.documentElement.dataset.editorTheme = "light";
    await settle();
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
