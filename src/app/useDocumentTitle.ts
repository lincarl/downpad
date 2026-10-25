import { useEffect } from "react";

/** Name the active document in the window title; unsaved state belongs in its tab. */
export function useDocumentTitle(
  activeTabId: string | null,
  filePath: string | null,
): void {
  useEffect(() => {
    if (activeTabId === null) {
      document.title = "Downpad";
      return;
    }
    document.title = `${fileLabel(filePath)} — Downpad`;
  }, [activeTabId, filePath]);
}

function fileLabel(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
