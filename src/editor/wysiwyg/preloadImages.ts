// Show local images at their real URL from the first render (spec §5.5).
//
// Crepe's image views render a node's raw Markdown src, then switch to what
// proxyDomURL answers. md-easy's answer for a local image comes from the main
// process, so it arrives after that first render, and Chromium looks a relative
// src up next to md-easy's own page in the meantime. That logs a failed load
// and could show one of md-easy's own files. This plugin asks proxyDomURL about
// every image in the document before the editor view is created. proxyDomURL
// keeps its answers (imageView.ts), so each view then starts with its URL.

import { EditorStateReady, editorStateCtx, editorViewTimerCtx } from "@milkdown/kit/core";
import { createTimer, type MilkdownPlugin } from "@milkdown/kit/ctx";
import { imageAttrs, isImageNode } from "./imageView";

/** The longest the first render waits for answers. Past it the document shows
 *  anyway, and images still waiting show as they did before this plugin. */
export const PRELOAD_LIMIT_MS = 1000;

/** A Milkdown plugin that holds the editor view back until `proxyDomURL` has
 *  answered for the document's images, or PRELOAD_LIMIT_MS has passed. */
export function preloadImages(proxyDomURL: (src: string) => string | Promise<string>): MilkdownPlugin {
  const ImagesReady = createTimer("ImagesReady");
  return (ctx) => {
    ctx.record(ImagesReady);
    ctx.update(editorViewTimerCtx, (timers) => [...timers, ImagesReady]);
    return async () => {
      await ctx.wait(EditorStateReady);
      const answers: Array<string | Promise<string>> = [];
      ctx.get(editorStateCtx).doc.descendants((node) => {
        if (isImageNode(node)) answers.push(proxyDomURL(imageAttrs(node).src));
      });
      let limit: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(answers),
        new Promise((resolve) => {
          limit = setTimeout(resolve, PRELOAD_LIMIT_MS);
        }),
      ]);
      clearTimeout(limit);
      ctx.done(ImagesReady);
      return () => {
        ctx.update(editorViewTimerCtx, (timers) => timers.filter((timer) => timer !== ImagesReady));
        ctx.clearTimer(ImagesReady);
      };
    };
  };
}
