// Show local images at their real URL from the first render (spec §5.5).
//
// Crepe's image views render a node's raw Markdown src, then switch to what
// proxyDomURL answers. Downpad's answer for a local image comes from the main
// process, so it arrives after that first render, and Chromium looks a relative
// src up next to Downpad's own page in the meantime. That logs a failed load
// and could show one of Downpad's own files. This plugin asks about every image
// in the document before the editor view is created. proxyDomURL keeps the
// answers (imageView.ts), so each view then starts with its URL.

import { EditorStateReady, editorStateCtx, editorViewTimerCtx } from "@milkdown/kit/core";
import { createTimer, type MilkdownPlugin } from "@milkdown/kit/ctx";
import { imageAttrs, isImageNode } from "./imageView";

/** A Milkdown plugin that holds the editor view back until `preload` settles
 *  for the document's image sources. The image feature config's `preload`
 *  bounds the wait (ANSWER_WAIT_MS), so a slow file system cannot keep the
 *  document from showing. */
export function preloadImages(preload: (srcs: readonly string[]) => Promise<void>): MilkdownPlugin {
  const ImagesReady = createTimer("ImagesReady");
  return (ctx) => {
    ctx.record(ImagesReady);
    ctx.update(editorViewTimerCtx, (timers) => [...timers, ImagesReady]);
    return async () => {
      await ctx.wait(EditorStateReady);
      const srcs: string[] = [];
      ctx.get(editorStateCtx).doc.descendants((node) => {
        if (isImageNode(node)) srcs.push(imageAttrs(node).src);
      });
      await preload(srcs);
      ctx.done(ImagesReady);
      return () => {
        ctx.update(editorViewTimerCtx, (timers) => timers.filter((timer) => timer !== ImagesReady));
        ctx.clearTimer(ImagesReady);
      };
    };
  };
}
