import { listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import type { Ctx } from "@milkdown/kit/ctx";

/** Crepe controls that only a pointer can use. Each has a keyboard route or
 *  none. "/" opens the block menu that the handle's + opens, the arrow keys
 *  switch slash menu groups, Enter confirms inline math, and the image context
 *  menu edits alt text. The table buttons act on the cell or line under the
 *  pointer and do nothing from the keyboard. */
const POINTER_ONLY = [
  ".milkdown-block-handle",
  ".milkdown-image-block .operation",
  ".milkdown-table-block .handle",
  ".milkdown-slash-menu .tab-group",
  ".milkdown-latex-inline-edit button",
].join(", ");

/** Attributes for the elements each selector matches. */
const RULES: ReadonlyArray<readonly [selector: string, attributes: Readonly<Record<string, string>>]> = [
  // Only the main editor. Crepe's inline math field is a ProseMirror too.
  [".milkdown > .ProseMirror", { "aria-label": "Document editor" }],
  [".milkdown-latex-inline-edit .ProseMirror", { role: "textbox", "aria-label": "Math formula" }],
  [".cm-content", { "aria-label": "Code block editor" }],
  // The link field of an image that has no source yet.
  [":is(.milkdown-image-block, .milkdown-image-inline) .link-input-area", { "aria-label": "Image link" }],
  // Icons are drawings. Icons named at config time (task boxes) keep their name.
  [".milkdown-icon svg:not([aria-label])", { "aria-hidden": "true" }],
  // Nothing inside stays focusable, so hiding these from screen readers is valid.
  [POINTER_ONLY, { "aria-hidden": "true" }],
  [`button:is(${POINTER_ONLY}), :is(${POINTER_ONLY}) button`, { tabindex: "-1" }],
  // The button shows only the language, so a description says what it picks.
  [".milkdown-code-block .language-button", { "aria-haspopup": "listbox", "aria-description": "Code language" }],
  [".milkdown-code-block .language-list", { "aria-label": "Code language" }],
  // Crepe marks the current language with aria-selected, which only options take.
  ['.milkdown-code-block .language-list li[role="listitem"]', { role: "option" }],
];

/** Apply every rule to `scope` and its descendants. */
function apply(scope: Element): void {
  for (const [selector, attributes] of RULES) {
    const matches = [...scope.querySelectorAll(selector)];
    if (scope.matches(selector)) matches.push(scope);
    for (const element of matches) {
      for (const [name, value] of Object.entries(attributes)) {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
      }
    }
  }
}

/**
 * Normalize accessibility attributes on DOM rendered by Crepe and its embedded
 * CodeMirror instances. These nodes are owned by third-party editor views, so
 * React cannot express the attributes directly. Elements added later get the
 * same attributes, and so does an element whose role Crepe's views set again
 * when they reuse it. Returns a function that stops watching.
 */
export function installEditorAccessibility(root: HTMLElement): () => void {
  apply(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) apply(record.target);
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) apply(node);
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["role"] });
  return () => observer.disconnect();
}

/** Give an SVG icon an image role and a name. */
function namedIcon(icon: string, name: string): string {
  return icon.replace("<svg", `<svg role="img" aria-label="${name}"`);
}

/** Name each task box "Done" or "Not done", which Crepe shows only as a
 *  drawing. The box is pointer-only, so it is an image, not a checkbox. Use as
 *  a Milkdown config after Crepe's list item feature has set its icons. */
export function labelTaskBoxes(ctx: Ctx): void {
  ctx.update(listItemBlockConfig.key, (prev) => ({
    ...prev,
    renderLabel: (props) => {
      const icon = prev.renderLabel(props);
      if (props.checked == null) return icon;
      return namedIcon(icon, props.checked ? "Done" : "Not done");
    },
  }));
}
