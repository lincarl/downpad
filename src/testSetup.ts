// Setup for every Vitest test file (vitest.config.ts).
//
// jsdom has no layout, and its Range has no getClientRects or
// getBoundingClientRect. Find in the document view measures the current match
// to scroll to it, so every test that searches the real editor needs them.
// Text gets the empty boxes a browser gives hidden text.
if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
  Object.assign(Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  });
}

// jsdom has no ResizeObserver. The document view watches its own width to hide
// Crepe's block handle (blockHandle.ts), so every test that builds the real
// editor needs one. jsdom has no layout, so no size ever changes, and this
// observer never calls back.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
