/**
 * Normalize accessibility attributes on DOM rendered by Crepe and its embedded
 * CodeMirror instances. These nodes are owned by third-party editor views, so
 * React cannot express the attributes directly.
 */
export function installEditorAccessibility(root: HTMLElement): () => void {
  const apply = (): void => {
    root.querySelectorAll<HTMLElement>(".ProseMirror").forEach((editor) => {
      if (!editor.hasAttribute("aria-label")) editor.setAttribute("aria-label", "Document editor");
    });

    root.querySelectorAll<HTMLElement>(".cm-content").forEach((editor) => {
      if (!editor.hasAttribute("aria-label")) editor.setAttribute("aria-label", "Code block editor");
    });

    root
      .querySelectorAll<HTMLButtonElement>('div[data-role="x-line-drag-handle"] > button.add-button')
      .forEach((button) => {
        if (!button.hasAttribute("aria-label")) button.setAttribute("aria-label", "Add table column");
      });
    root
      .querySelectorAll<HTMLButtonElement>('div[data-role="y-line-drag-handle"] > button.add-button')
      .forEach((button) => {
        if (!button.hasAttribute("aria-label")) button.setAttribute("aria-label", "Add table row");
      });

  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
