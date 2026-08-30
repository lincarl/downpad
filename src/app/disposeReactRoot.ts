import type { Root } from "react-dom/client";

/**
 * Detach a compatibility root immediately, then let React run its effect
 * cleanup after the current render/event has finished. React 19 warns when a
 * nested root is synchronously unmounted from another root's lifecycle.
 */
export function disposeReactRoot(root: Root, host?: HTMLElement | null): void {
  host?.remove();
  queueMicrotask(() => root.unmount());
}
