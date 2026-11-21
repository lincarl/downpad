import { describe, expect, it } from "vitest";
import type { FileDialogFilter } from "../ipc/bridge";
import { DOCUMENT_EXTENSIONS, documentLanguage, extensionOf, isProse, openFileFilters, saveFileFilters, takesNoFiles } from "./documentLanguage";

describe("extensionOf", () => {
  it("gives the extension in lower case, for both slash styles", () => {
    expect(extensionOf("C:\\notes\\Draft.MD")).toBe("md");
    expect(extensionOf("/home/me/pic.PNG")).toBe("png");
  });

  it("gives none for a name without one, also below a folder with a dot", () => {
    expect(extensionOf("C:/notes/README")).toBe("");
    expect(extensionOf("C:/my.dir/file")).toBe("");
    expect(extensionOf("/srv/data.json/")).toBe("json");
  });

  it("takes a dot that starts the name as part of the name", () => {
    expect(extensionOf("/app/.prettierrc")).toBe("");
    expect(extensionOf("C:\\app\\.json")).toBe("");
    expect(extensionOf("/app/.eslintrc.json")).toBe("json");
    expect(extensionOf("/app/copy.")).toBe("");
  });
});

describe("documentLanguage", () => {
  it("reads a .json file as JSON, a .yaml or .yml file as YAML and a .txt file as text, whatever the case", () => {
    expect(documentLanguage("/app/package.json")).toBe("json");
    expect(documentLanguage("C:\\app\\Settings.JSON")).toBe("json");
    expect(documentLanguage("/srv/compose.yaml")).toBe("yaml");
    expect(documentLanguage("/srv/ci.YML")).toBe("yaml");
    expect(documentLanguage("/notes/a.txt")).toBe("text");
    expect(documentLanguage("C:\\notes\\Todo.TXT")).toBe("text");
  });

  it("reads every other document as Markdown, also an untitled one", () => {
    expect(documentLanguage(null)).toBe("markdown");
    expect(documentLanguage("/notes/a.md")).toBe("markdown");
    expect(documentLanguage("/notes/a.markdown")).toBe("markdown");
    expect(documentLanguage("/notes/README")).toBe("markdown");
    expect(documentLanguage("/notes/a.text")).toBe("markdown");
    // Only the last extension counts, and a folder's name does not.
    expect(documentLanguage("/notes/a.txt.md")).toBe("markdown");
    expect(documentLanguage("/notes/a.json.md")).toBe("markdown");
    expect(documentLanguage("/data.yaml/notes")).toBe("markdown");
    expect(documentLanguage("/notes/json")).toBe("markdown");
    expect(documentLanguage("/app/.json")).toBe("markdown");
    expect(documentLanguage("/notes/.txt")).toBe("markdown");
  });
});

describe("isProse", () => {
  it("counts Markdown and text as prose, and JSON and YAML as data", () => {
    expect(isProse("markdown")).toBe(true);
    expect(isProse("text")).toBe(true);
    expect(isProse("json")).toBe(false);
    expect(isProse("yaml")).toBe(false);
  });
});

describe("takesNoFiles", () => {
  it("gives the reason for a text, JSON or YAML file, and none for a Markdown document", () => {
    expect(takesNoFiles("/data/a.json")?.message).toBe("A JSON file takes no dropped files. Drop them on a Markdown document.");
    expect(takesNoFiles("/data/a.yml")?.message).toBe("A YAML file takes no dropped files. Drop them on a Markdown document.");
    expect(takesNoFiles("/notes/a.txt")?.message).toBe("A text file takes no dropped files. Drop them on a Markdown document.");
    expect(takesNoFiles("/notes/a.md")).toBeNull();
    expect(takesNoFiles("/notes/README")).toBeNull();
    expect(takesNoFiles(null)).toBeNull();
  });
});

describe("DOCUMENT_EXTENSIONS", () => {
  it("holds the extensions of every kind of document, and no other", () => {
    expect(DOCUMENT_EXTENSIONS).toEqual(["md", "markdown", "mdown", "mkd", "txt", "json", "yaml", "yml"]);
  });
});

describe("openFileFilters", () => {
  const names = (filters: FileDialogFilter[]): string[] => filters.map((filter) => filter.name);

  it("puts every supported file after the kinds, and before all files, by default", () => {
    const filters = openFileFilters(false);
    expect(names(filters)).toEqual(["Markdown", "Text", "JSON", "YAML", "All supported files", "All files"]);
    expect(filters[4].extensions).toEqual(["md", "markdown", "mdown", "mkd", "txt", "json", "yaml", "yml"]);
    expect(filters[5].extensions).toEqual(["*"]);
  });

  it("puts every supported file first, which the dialog then selects, when asked", () => {
    const filters = openFileFilters(true);
    expect(names(filters)).toEqual(["All supported files", "Markdown", "Text", "JSON", "YAML", "All files"]);
    expect(filters[0].extensions).toEqual([...DOCUMENT_EXTENSIONS]);
  });

  it("gives each call its own lists, so a dialog cannot change the next one's", () => {
    const first = openFileFilters(true);
    first[0].extensions.push("changed");
    first[1].extensions.push("changed");
    expect(openFileFilters(true)[0].extensions).toEqual([...DOCUMENT_EXTENSIONS]);
    expect(openFileFilters(true)[1].extensions).toEqual(["md", "markdown", "mdown", "mkd"]);
  });
});

describe("saveFileFilters", () => {
  const names = (filters: FileDialogFilter[]): string[] => filters.map((filter) => filter.name);

  it("puts the document's own kind first, whose first extension a Windows save dialog adds to a bare name", () => {
    expect(names(saveFileFilters())).toEqual(["Markdown", "Text", "JSON", "YAML", "All files"]);
    expect(names(saveFileFilters("/notes/README"))).toEqual(["Markdown", "Text", "JSON", "YAML", "All files"]);
    expect(names(saveFileFilters("/notes/a.txt"))).toEqual(["Text", "Markdown", "JSON", "YAML", "All files"]);
    expect(names(saveFileFilters("/app/package.json"))).toEqual(["JSON", "Markdown", "Text", "YAML", "All files"]);
    expect(saveFileFilters("/srv/compose.yaml")[0]).toEqual({ name: "YAML", extensions: ["yaml", "yml"] });
  });

  it("offers no filter of every supported file, whose first extension would make any document Markdown", () => {
    for (const path of [null, "/notes/a.txt", "/app/package.json"]) {
      expect(names(saveFileFilters(path))).not.toContain("All supported files");
    }
  });

  it("puts the document's own extension first in its kind, so a .yml or .markdown file keeps it", () => {
    expect(saveFileFilters("/srv/compose.YML")[0]).toEqual({ name: "YAML", extensions: ["yml", "yaml"] });
    expect(saveFileFilters("/notes/a.markdown")[0]).toEqual({ name: "Markdown", extensions: ["markdown", "md", "mdown", "mkd"] });
    // Another kind's filter keeps its own order.
    expect(saveFileFilters("/srv/compose.yml")[3]).toEqual({ name: "JSON", extensions: ["json"] });
  });

  it("gives each call its own lists, so a dialog cannot change the next one's", () => {
    saveFileFilters()[0].extensions.push("changed");
    expect(saveFileFilters()[0].extensions).toEqual(["md", "markdown", "mdown", "mkd"]);
  });
});
