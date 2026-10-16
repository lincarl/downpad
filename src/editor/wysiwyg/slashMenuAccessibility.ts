// Screen reader support for Crepe's slash menu. Typing "/" opens the block menu
// while focus stays in the document, and the arrow keys move a highlight that
// Crepe shows only as the "hover" class on a plain list item. Screen readers
// announced nothing as it moved.
//
// This marks the menu up as a listbox of options, grouped under Crepe's
// captions, and points the editor's aria-activedescendant at the highlighted
// option while the menu is open. ProseMirror only updates attributes it set
// itself, so the ones added to the editor stay until this removes them.

/** Count of wired menus, so that every editor's menu gets its own element ids. */
let menuCount = 0;

/** Set each attribute that differs, and remove those given as null. */
function setAttributes(element: Element, attributes: Readonly<Record<string, string | null>>): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) element.removeAttribute(name);
    else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
}

/**
 * Keep the slash menu inside `root` exposed as a listbox, and keep the main
 * editor's aria-activedescendant on its highlighted option while it is open.
 * Follows the menu as Crepe re-renders, opens and closes it. Returns a function
 * that stops watching and takes those attributes off the editor.
 */
export function installSlashMenuAccessibility(root: HTMLElement): () => void {
  const listId = `slash-menu-${++menuCount}`;

  /** Mark the menu up as a listbox, and point the editor at the highlighted
   *  option only while the menu is open. */
  const sync = (): void => {
    const menu = root.querySelector<HTMLElement>(".milkdown-slash-menu");
    const list = menu?.querySelector(".menu-groups");
    if (list) {
      setAttributes(list, { id: listId, role: "listbox", "aria-label": "Insert block" });
      for (const group of list.querySelectorAll(".menu-group")) {
        // The group is named after its caption, so the caption is hidden
        // instead of being read as an extra item.
        const caption = group.querySelector("h6");
        setAttributes(group, { role: "group", "aria-label": caption?.textContent ?? null });
        if (caption) setAttributes(caption, { "aria-hidden": "true" });
        // Without this, Chromium keeps each item a list item.
        const items = group.querySelector("ul");
        if (items) setAttributes(items, { role: "none" });
      }
      for (const option of list.querySelectorAll<HTMLElement>("li[data-index]")) {
        setAttributes(option, {
          id: `${listId}-option-${option.dataset.index}`,
          role: "option",
          "aria-selected": String(option.classList.contains("hover")),
        });
      }
    }

    const editor = root.querySelector(".milkdown > .ProseMirror");
    if (!editor) return;
    const open = menu?.dataset.show === "true";
    const active = open ? list?.querySelector("li[data-index].hover") : null;
    setAttributes(editor, {
      "aria-controls": open && list ? listId : null,
      "aria-activedescendant": active?.id ?? null,
    });
  };

  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-show", "data-index"],
  });
  return () => {
    observer.disconnect();
    // Nothing would clear these once the watching stops.
    const editor = root.querySelector(".milkdown > .ProseMirror");
    if (editor) setAttributes(editor, { "aria-controls": null, "aria-activedescendant": null });
  };
}
