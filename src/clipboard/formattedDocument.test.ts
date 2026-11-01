// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFormattedDocument, formatDocument } from "./formattedDocument";

afterEach(() => vi.unstubAllGlobals());

describe("formatted document", () => {
  it("copies semantic formatting, complete code blocks and readable text", async () => {
    const code = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n");
    const { html, text } = await formatDocument([
      "# Notes",
      "**Bold**, *italic*, ~~removed~~ and [link](https://example.com).",
      "- First\n- Second\n  - Nested",
      "3. Third\n4. Fourth",
      "- [x] Done\n- [ ] Next",
      "| Name | Value |\n| --- | --- |\n| Key | Answer |",
      `\`\`\`ts\n${code}\n\`\`\``,
    ].join("\n\n"));
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector("h1")?.textContent).toBe("Notes");
    expect(root.querySelector("strong")?.textContent).toBe("Bold");
    expect(root.querySelector("em")?.textContent).toBe("italic");
    expect(root.querySelector("del")?.textContent).toBe("removed");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(root.querySelector("ul ul li")?.textContent).toBe("Nested");
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("pre code")?.textContent).toBe(code);
    expect(root.querySelectorAll("table tr")).toHaveLength(2);
    expect(root.querySelector("button, input, .cm-editor, .ProseMirror")).toBeNull();
    expect(text).toContain("Notes\n\nBold, italic, removed and link.");
    expect(text).toContain("• First\n• Second");
    expect(text).toContain("3. Third\n4. Fourth");
    expect(text).toContain("☑ Done");
    expect(text).toContain("☐ Next");
    expect(text).toContain("Name\tValue\nKey\tAnswer");
    expect(text).toContain(code);
    expect(document.querySelector(".milkdown, .ProseMirror")).toBeNull();
  });

  it("keeps local links and images anchored to the source document", async () => {
    const markdown = [
      "[Relative](../other%20file.md#intro)",
      "[Windows](C:/notes/other.md)",
      "[File](file:///notes/other.md)",
      "![Local image](images/diagram.png)",
      "![Web image](//example.com/image.png)",
      "[Unsafe](javascript:alert%281%29)",
    ].join("\n\n");
    for (const [filePath, relative, image] of [
      ["/notes/a #1%/index.md", "file:///notes/other%20file.md#intro", "file:///notes/a%20%231%25/images/diagram.png"],
      ["C:\\notes\\drafts\\index.md", "file:///C:/notes/other%20file.md#intro", "file:///C:/notes/drafts/images/diagram.png"],
      ["\\\\server\\share\\drafts\\index.md", "file://server/share/other%20file.md#intro", "file://server/share/drafts/images/diagram.png"],
    ]) {
      const { html } = await formatDocument(markdown, filePath);
      const root = document.createElement("div");
      root.innerHTML = html;
      expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        relative, "file:///C:/notes/other.md", "file:///notes/other.md", null,
      ]);
      expect([...root.querySelectorAll("img")].map((node) => node.getAttribute("src"))).toEqual([
        image, "https://example.com/image.png",
      ]);
    }
    const { html } = await formatDocument("[Unresolved](relative.md)");
    expect(html).toBe("<p><a>Unresolved</a></p>");
  });

  it("builds the copy without loading its images", async () => {
    // An <img> made in the page loads its src at once, even outside the page,
    // and Chromium reads `//server/share/a.png` there from the file server.
    const creating = vi.spyOn(document, "createElement");
    try {
      const { html } = await formatDocument("![Shared](//server/share/a.png) and ![Local](a.png)", "/notes/index.md");
      expect(creating.mock.calls.map(([tag]) => tag)).not.toContain("img");
      expect(html).toBe('<p><img src="https://server/share/a.png" alt="Shared" title=""> and <img src="file:///notes/a.png" alt="Local" title=""></p>');
    } finally {
      creating.mockRestore();
    }
  });

  it("separates footnote labels from body text in plain-text copies", async () => {
    const { html, text } = await formatDocument("Text[^1] and another[^note].\n\n[^1]: A footnote.\n\n[^note]: A **named** footnote.");
    expect(text).toBe("Text[1] and another[note].\n\n[1] A footnote.\n\n[note] A named footnote.");
    expect(html).toContain('<sup data-label="1" data-type="footnote_reference">1</sup>');
    expect(html).toContain("<strong>named</strong>");
  });

  it("keeps metadata and special content readable without executing embedded HTML", async () => {
    const { html, text } = await formatDocument([
      "---\ntitle: Notes\n---",
      "Inline $x_1 + y_2$ and prices $5 or $10.",
      "$$\nx_1 + y_2\n$$",
      "```mermaid\ngraph LR\nA --> B\n```",
      '<script>alert("bad")</script>',
      "[Unsafe](javascript:alert%281%29) and ![Diagram](diagram.png)",
    ].join("\n\n"));
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector("pre code")?.textContent).toBe("---\ntitle: Notes\n---");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("Diagram");
    expect(text).toContain("Inline $x_1 + y_2$ and prices $5 or $10.");
    expect(root.querySelector("p code")?.textContent).toBe("$x_1 + y_2$");
    expect(root.querySelector('pre[data-language="LaTeX"] code')?.textContent).toBe("x_1 + y_2");
    expect(text).toContain("graph LR\nA --> B");
    expect(text).toContain("Diagram");
  });

  it("writes both clipboard types and propagates refused writes", async () => {
    let content: Record<string, Blob> = {};
    vi.stubGlobal("ClipboardItem", class {
      constructor(data: Record<string, Blob>) { content = data; }
    });
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    await copyFormattedDocument("**Latest** text.");
    expect(write).toHaveBeenCalledOnce();
    expect(Object.keys(content).sort()).toEqual(["text/html", "text/plain"]);
    expect(content["text/html"]?.type).toBe("text/html");
    expect(content["text/plain"]?.type).toBe("text/plain");
    const refused = new Error("Clipboard permission denied");
    write.mockRejectedValue(refused);
    await expect(copyFormattedDocument("More text.")).rejects.toBe(refused);
  });

  it("reports unavailable rich clipboard access without a plain-only fallback", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    await expect(copyFormattedDocument("**Text**")).rejects.toThrow("Formatted clipboard access is unavailable");
  });
});
