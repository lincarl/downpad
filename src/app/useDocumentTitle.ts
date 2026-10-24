import { useEffect } from "react";

export function useDocumentTitle(
  activeTabId: string | null,
  filePath: string | null,
  isDirty: boolean,
): void {
  useEffect(() => {
    if (activeTabId === null) {
      document.title = "Downpad";
      return;
    }
    document.title = `${isDirty ? "● " : ""}${fileLabel(filePath)} — Downpad`;
  }, [activeTabId, filePath, isDirty]);
}

function fileLabel(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
