// Decides where a pasted/dropped image goes (spec §5.5): embedded as a base64
// data URI, or written to the attachments folder and linked. The decision is a
// pure function of the image size + settings + whether the document has a saved
// path; `storeImage` then carries it out and returns the markdown image `src`.
//
// Per the agreed behaviour, base64 embedding works even in an untitled buffer
// (no folder needed); only the attachment path requires a saved file, hence the
// "need-save" outcome.
//
// `storeBesideDocument` keeps a file written to the attachments folder beside
// its document when a Save As moves the document meanwhile. Images stored as
// files and other dropped files both go through it. An embedded image does not
// depend on where its document is saved, so it never waits for a Save As.
// Only pasted and dropped files wait for a Save As under way first
// (FileDropCoordinator), because EditorHost puts them into the view shown
// once they are stored.

import type { Settings } from "../state/types";
import { sameFilePath } from "../files/pathIdentity";
import { writeAttachment as writeAttachmentIpc } from "../ipc/commands";
import { attachmentFileName } from "./attachments";
import { dirName, isRemoteOrData } from "./pathResolve";

export type StorageDecision = "embed" | "attachment" | "need-save";

export interface DecisionInputs {
  /** Image size in bytes. */
  byteSize: number;
  embedImagesAsBase64: boolean;
  /** Threshold in KB; images above this are never embedded. */
  maxEmbedSizeKB: number;
  /** Whether the document has been saved (has a path to anchor attachments to). */
  hasFilePath: boolean;
}

/** Pure decision: embed as base64, write to attachments, or require a save first. */
export function decideImageStorage(i: DecisionInputs): StorageDecision {
  const withinEmbedLimit = i.byteSize <= i.maxEmbedSizeKB * 1024;
  if (i.embedImagesAsBase64 && withinEmbedLimit) return "embed";
  // Attachment path is required, which needs a folder next to a saved file.
  return i.hasFilePath ? "attachment" : "need-save";
}

/** Base64-encode bytes in chunks (avoids stack overflow on large buffers). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface StoreImageParams {
  bytes: Uint8Array;
  mime: string;
  settings: Settings;
  filePath: string | null;
  /** Defaults to now; pass explicitly in tests for determinism. */
  isoTimestamp?: string;
}

export interface StoreImageResult {
  decision: StorageDecision;
  /** The markdown image `src` (data URI or relative path); absent when need-save. */
  src?: string;
}

/**
 * Carry out the storage decision. For `embed`, returns a data URI; for
 * `attachment`, writes the file and returns the relative link; for `need-save`,
 * returns no src (the caller should prompt the user to save, then retry).
 * `writeAttachment` is injectable for tests.
 */
export async function storeImage(
  params: StoreImageParams,
  writeAttachment: typeof writeAttachmentIpc = writeAttachmentIpc,
): Promise<StoreImageResult> {
  const { bytes, mime, settings, filePath } = params;
  const decision = decideImageStorage({
    byteSize: bytes.length,
    embedImagesAsBase64: settings.embedImagesAsBase64,
    maxEmbedSizeKB: settings.maxEmbedSizeKB,
    hasFilePath: filePath !== null,
  });

  if (decision === "embed") {
    return { decision, src: `data:${mime};base64,${bytesToBase64(bytes)}` };
  }
  if (decision === "attachment" && filePath) {
    const fileName = attachmentFileName(mime, params.isoTimestamp);
    const src = await writeAttachment(filePath, settings.attachmentsFolderName, fileName, bytes);
    return { decision, src };
  }
  return { decision: "need-save" };
}

/** What `resolveImageSrc` needs from the app, without coupling to the Store. */
export interface ImageStoreContext {
  getSettings(): Settings;
  /** The document's saved path, or null while it has none. Read right before
   *  each try to store the image, so an image written to the attachments
   *  folder goes beside the path it gave last. */
  getFilePath(): string | null;
  /** Prompt-and-save an untitled buffer; resolves true once it has a path. */
  requestSave(): Promise<boolean>;
  /** Resolve once no save that can give the document a new path is under
   *  way, with its dialog open or its file being written
   *  (`FileService.untilPathSettled`). Pasted and dropped files wait for this
   *  (FileDropCoordinator). Omit it where the image goes into the editor that
   *  asked for it, as for the document view's upload input and Replace
   *  image. That editor can be rebuilt or dropped from memory during a long
   *  wait, which loses the image (§5.5). */
  untilPathSettled?(): Promise<void>;
}

/**
 * Store a file beside a document with `store`, and resolve the link `store`
 * gives it, or null if it stored nothing. `store` writes the file beside the
 * document path that the `getFilePath` it is passed gives right before the
 * write, and the link leads from there. With `untilPathSettled`, a Save As
 * of the document that is under way, its dialog open or its file being
 * written, finishes first, so the file goes beside the document where it is
 * saved then. Pasted and dropped files use that wait, and images uploaded or
 * replaced in the document view leave it out (§5.4, §5.5). Either way, if the
 * document is saved in another folder while the file is written, the file is
 * stored again beside it there, so its link leads from the document's own
 * folder. The copy in the old folder stays.
 */
export async function storeBesideDocument(
  doc: Pick<ImageStoreContext, "getFilePath" | "untilPathSettled">,
  store: (getFilePath: () => string | null) => Promise<string | null>,
): Promise<string | null> {
  for (;;) {
    await doc.untilPathSettled?.();
    // `store` sets this as it reads the path to write beside.
    let storedBeside: string | null = null;
    const link = await store(() => (storedBeside = doc.getFilePath()));
    await doc.untilPathSettled?.();
    if (!link || isRemoteOrData(link) || !movedFrom(storedBeside, doc.getFilePath())) return link;
  }
}

/** Whether a document saved at `now` is in a folder other than the one
 *  `filePath` is in. False when either is not saved. */
function movedFrom(filePath: string | null, now: string | null): boolean {
  return filePath !== null && now !== null && !sameFilePath(dirName(now), dirName(filePath));
}

/**
 * Store an image and return its markdown `src`, transparently handling the
 * untitled-buffer case: if the image must go to attachments but there's no
 * saved path yet, prompt a save and retry once. Returns null if the user
 * cancels the save (nothing is inserted).
 *
 * An embedded image does not depend on where the document is saved, so it
 * never waits. An image written to the attachments folder goes beside the
 * document where it is saved once it is written (`storeBesideDocument`).
 * `beforeInsert` runs for it with the document path it was written beside,
 * such as to look up its URL before it goes in. It runs before the check that
 * the document is still in that folder, so if a Save As moves the document
 * meanwhile, the image is written again and `beforeInsert` runs again.
 */
export async function resolveImageSrc(
  bytes: Uint8Array,
  mime: string,
  ctx: ImageStoreContext,
  beforeInsert?: (src: string, filePath: string) => Promise<void>,
): Promise<string | null> {
  // Without a path, storeImage writes nothing, and embeds what it can.
  const embedded = await storeImage({ bytes, mime, settings: ctx.getSettings(), filePath: null });
  if (embedded.decision === "embed") return embedded.src ?? null;
  return storeBesideDocument(ctx, async (getFilePath) => {
    // The document path the image is written beside.
    let filePath = getFilePath();
    let result = await storeImage({ bytes, mime, settings: ctx.getSettings(), filePath });
    if (result.decision === "need-save") {
      if (!(await ctx.requestSave())) return null;
      filePath = getFilePath();
      result = await storeImage({ bytes, mime, settings: ctx.getSettings(), filePath });
    }
    if (!result.src) return null;
    if (filePath && !isRemoteOrData(result.src)) await beforeInsert?.(result.src, filePath);
    return result.src;
  });
}
