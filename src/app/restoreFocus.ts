/**
 * Remember the focused element and return a function that puts focus back on it
 * once a programmatic dialog has gone. Removing a dialog's host drops focus to
 * the page body, so the next Tab would start again at the top of the window.
 * Focus that has meanwhile moved somewhere real is left alone.
 */
export function captureFocus(): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return () => {
    // Run after React has unmounted the dialog and its focus scope.
    setTimeout(() => {
      if (!opener?.isConnected) return;
      const current = document.activeElement;
      if (current && current !== document.body) return;
      opener.focus();
    }, 0);
  };
}
