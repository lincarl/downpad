// Right-click context menu for images in the WYSIWYG view (spec §5.5): Copy
// image, Copy image path, Copy as Markdown | Replace image…, Edit alt text… |
// Delete, with Mervin-style icons and separators between the copy, edit and
// delete groups. Implemented as a $prose plugin so it has the EditorView
// directly; it also publishes the view into the shared ViewRef used by the
// missing-image handler (imageView.ts). All mutations go through ProseMirror
// transactions.
//
// "Copy image" uses the DOM clipboard (ClipboardItem) per design risk #9 — no
// native command needed — normalizing to image/png via a canvas.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { readImageBytes } from "../../ipc/commands";
import { resolveImageSrc } from "../../images/imageStore";
import { resolveImagePath } from "../../images/pathResolve";
import {
  closeContextMenu,
  showContextMenu,
  type MenuItem,
} from "../../shell/contextMenu";
import {
  imageAttrs,
  imageNodeAtPos,
  pickImageFile,
  setImageAttrs,
  type ViewRef,
} from "./imageView";
import type { WysiwygContext } from "./context";
import { openTextPrompt } from "../../components/TextPromptDialog";
import { MENU_ICONS } from "../../shell/menuIcons";
import { mdImage } from "../../paste/mdLink";

export const imageContextMenuKey = new PluginKey("md-easy-image-context-menu");

// ── Copy image to the clipboard as image/png ──

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageBlob(src: string, ctx: WysiwygContext): Promise<Blob | null> {
  if (src.startsWith("data:")) return (await fetch(src)).blob();
  const abs = resolveImagePath(src, ctx.getFilePath());
  if (!abs) return null;
  const { bytes, mime } = await readImageBytes(abs);
  return new Blob([bytes], { type: mime });
}

async function copyImage(src: string, ctx: WysiwygContext): Promise<void> {
  const blob = await imageBlob(src, ctx);
  if (!blob) return;
  const png = await toPngBlob(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function replaceImage(view: EditorView, pos: number, node: ProseNode, ctx: WysiwygContext): Promise<void> {
  const path = await pickImageFile();
  if (!path) return;
  const { bytes, mime } = await readImageBytes(path);
  const src = await resolveImageSrc(bytes, mime, ctx);
  if (src) setImageAttrs(view, pos, node, { src });
}

function buildItems(
  view: EditorView,
  node: ProseNode,
  pos: number,
  ctx: WysiwygContext,
): MenuItem[] {
  const { src, alt, title } = imageAttrs(node);
  return [
    { label: "Copy image", icon: MENU_ICONS.copy, run: () => copyImage(src, ctx).catch(() => {}) },
    {
      label: "Copy image path",
      icon: MENU_ICONS.copyPath,
      run: () => void navigator.clipboard.writeText(src).catch(() => {}),
    },
    {
      label: "Copy as Markdown",
      icon: MENU_ICONS.markdown,
      run: () => void navigator.clipboard.writeText(mdImage(alt, src, title)).catch(() => {}),
    },
    {
      label: "Replace image…",
      icon: MENU_ICONS.replaceImage,
      separatorBefore: true,
      run: () => replaceImage(view, pos, node, ctx),
    },
    {
      label: "Edit alt text…",
      icon: MENU_ICONS.edit,
      run: async () => {
        const next = await openTextPrompt({
          title: "Edit alt text",
          label: "Alt text",
          initialValue: alt,
          confirmLabel: "Save",
        });
        if (next !== null) setImageAttrs(view, pos, node, { alt: next });
      },
    },
    {
      label: "Delete",
      icon: MENU_ICONS.delete,
      separatorBefore: true,
      run: () => {
        view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        view.focus();
      },
    },
  ];
}

/** A $prose plugin: publishes the EditorView and shows the image context menu. */
export function imageContextMenuPlugin(viewRef: ViewRef, ctx: WysiwygContext) {
  return $prose(
    () =>
      new Plugin({
        key: imageContextMenuKey,
        view: (editorView) => {
          viewRef.current = editorView;
          return {
            destroy() {
              if (viewRef.current === editorView) viewRef.current = null;
              closeContextMenu();
            },
          };
        },
        props: {
          handleDOMEvents: {
            contextmenu: (view: EditorView, event: MouseEvent): boolean => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const found = imageNodeAtPos(view, at.inside >= 0 ? at.inside : at.pos);
              if (!found) return false;
              event.preventDefault();
              showContextMenu(event.clientX, event.clientY, buildItems(view, found.node, found.pos, ctx), "Image");
              return true;
            },
          },
        },
      }),
  );
}
