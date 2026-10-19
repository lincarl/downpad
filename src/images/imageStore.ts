// Decides where a pasted/dropped image goes (spec §5.5): embedded as a base64
// data URI, or written to the attachments folder and linked. The decision is a
// pure function of the image size + settings + whether the document has a saved
// path; `storeImage` then carries it out and returns the markdown image `src`.
//
// Per the agreed behaviour, base64 embedding works even in an untitled buffer
// (no folder needed); only the attachment path requires a saved file, hence the
// "need-save" outcome.

import type { Settings } from "../state/types";
import { writeAttachment as writeAttachmentIpc } from "../ipc/commands";
import { attachmentFileName } from "./attachments";

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
  /** The document's saved path. Read right before each try to store the
   *  image, so an image written to the attachments folder goes beside the
   *  path it gave last. */
  getFilePath(): string | null;
  /** Prompt-and-save an untitled buffer; resolves true once it has a path. */
  requestSave(): Promise<boolean>;
}

/**
 * Store an image and return its markdown `src`, transparently handling the
 * untitled-buffer case: if the image must go to attachments but there's no
 * saved path yet, prompt a save and retry once. Returns null if the user
 * cancels the save (nothing is inserted).
 */
export async function resolveImageSrc(
  bytes: Uint8Array,
  mime: string,
  ctx: ImageStoreContext,
): Promise<string | null> {
  let result = await storeImage({ bytes, mime, settings: ctx.getSettings(), filePath: ctx.getFilePath() });
  if (result.decision === "need-save") {
    if (!(await ctx.requestSave())) return null;
    result = await storeImage({ bytes, mime, settings: ctx.getSettings(), filePath: ctx.getFilePath() });
  }
  return result.src ?? null;
}
