/// <reference types="vite/client" />

// Injected at build time from package.json's version (see vite.config.ts).
declare const __APP_VERSION__: string;

// @joplin/turndown-plugin-gfm ships no type declarations. It exports Turndown
// plugins (functions taking a TurndownService). See src/paste/htmlToMarkdown.ts.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  type TurndownPlugin = (service: TurndownService) => void;
  export const gfm: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
}
