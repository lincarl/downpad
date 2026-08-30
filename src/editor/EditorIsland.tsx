import { useLayoutEffect, useRef } from "react";
import type { Store } from "@/state/store";
import { EditorHost } from "./EditorHost";

export interface EditorIslandProps {
  store: Store;
  onHostReady(host: EditorHost): void;
  onHostDisposed(host: EditorHost): void;
}

/**
 * React's ownership boundary around the long-lived imperative editor panes.
 *
 * EditorHost deliberately retains one pane per `(tab, view)` beneath this
 * stable DOM node so tab switches preserve editor state and undo history.
 * React owns the node and this effect owns exactly one host instance for it.
 * The identity-aware callbacks keep Strict Mode's setup/cleanup replay from
 * clearing or disposing the replacement host.
 */
export function EditorIsland({
  store,
  onHostReady,
  onHostDisposed,
}: EditorIslandProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const host = new EditorHost(root, store);
    onHostReady(host);

    return () => {
      // Terminal disposal is idempotent and removes only DOM owned by this
      // particular host. A Strict Mode replacement may already own the same
      // React node by the time its asynchronous editor teardown settles.
      void host.dispose();
      onHostDisposed(host);
    };
  }, [onHostDisposed, onHostReady, store]);

  return <div ref={rootRef} className="editor-host flex h-full min-h-0 flex-row" />;
}
