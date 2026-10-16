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
