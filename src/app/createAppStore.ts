import { DEFAULT_SETTINGS } from "@/settings/defaults";
import { Store } from "@/state/store";
import { layoutFromDefaultView, type AppState } from "@/state/types";

const SEED = `---
title: Welcome
tags: [demo, markdown]
metadata:
  category: demo
---

# Welcome to md-easy

A lightweight, pure-WYSIWYG markdown editor.

## Try the toggle

Edit here, then switch between **WYSIWYG** and *Raw* with the toolbar button.
The two views share one markdown string, so switching never loses content.

- Ordered and unordered lists
- **Bold**, *italic*, and \`inline code\`
- [Links](https://example.com)

\`\`\`ts
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Status |
| ------- | ------ |
| WYSIWYG | M1     |
| Raw     | M1     |

> Single source of truth: the markdown string is canonical.
`;

export function createAppStore(): Store {
  const doc = {
    markdown: SEED,
    filePath: null,
    isDirty: false,
    savedMarkdown: SEED,
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const tab = { id: crypto.randomUUID(), doc };
  const initial: AppState = {
    view: "wysiwyg",
    sessionId: crypto.randomUUID(),
    doc,
    tabs: [tab],
    activeTabId: tab.id,
    editorLayout: layoutFromDefaultView(DEFAULT_SETTINGS),
    settings: DEFAULT_SETTINGS,
    find: {
      open: false,
      query: "",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      current: 0,
      total: 0,
    },
    banner: null,
    saveStatus: { lastSavedAt: null, autosaving: false },
    started: false,
  };
  return new Store(initial);
}
