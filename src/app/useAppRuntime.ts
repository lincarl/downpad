import { useEffect, useState, type RefObject } from "react";
import type { EditorHost } from "@/editor/EditorHost";
import type { Store } from "@/state/store";
import { AppRuntime } from "./AppRuntime";

export interface AppRuntimeRefs {
  editorArea: RefObject<HTMLElement | null>;
  recentHost: RefObject<HTMLElement | null>;
  findHost: RefObject<HTMLElement | null>;
}

/** Own the non-visual application runtime for the lifetime of the React shell. */
export function useOwnedAppRuntime(
  store: Store,
  editorHost: EditorHost | null,
  refs: AppRuntimeRefs,
  setRecentSummary: (text: string) => void,
): AppRuntime | null {
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);

  useEffect(() => {
    const editorArea = refs.editorArea.current;
    const recentHost = refs.recentHost.current;
    const findHost = refs.findHost.current;
    if (!editorHost || !editorArea || !recentHost || !findHost) return;

    let cancelled = false;
    let current: AppRuntime | null = null;
    // The runtime mounts isolated React roots for editor-adjacent UI. Starting
    // after the parent commit avoids nested flushes during React's lifecycle and
    // makes the owner safe under Strict Mode's setup/cleanup replay.
    queueMicrotask(() => {
      if (cancelled) return;
      current = new AppRuntime(
        store,
        editorHost,
        { editorArea, recentHost, findHost },
        { setRecentSummary },
      );
      setRuntime(current);
    });

    return () => {
      cancelled = true;
      const owned = current;
      current = null;
      if (owned) queueMicrotask(() => owned.dispose());
    };
  }, [editorHost, refs.editorArea, refs.findHost, refs.recentHost, setRecentSummary, store]);

  return runtime;
}
