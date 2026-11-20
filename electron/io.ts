import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FILE_CHANGED_ON_DISK, type FileMeta, type FilePayload, type FileStamp, type ImageBytes } from "../src/ipc/contracts";
import type { Eol } from "../src/state/types";

export function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("An absolute file path is required.");
  }
  return resolve(value);
}

const WINDOWS_SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/** A check that runs just before a rename replaces `target`, the real file and not a
 *  symbolic link to it, and answers whether the rename may go ahead. */
type BeforeReplace = (target: string) => Promise<boolean>;

/** Allow briefly held Windows handles to close before failing an atomic replacement.
 *  `beforeReplace` runs before each attempt, also a retry, and a false answer
 *  throws ReplaceDeclinedError. */
async function renameAtomic(source: string, destination: string, beforeReplace?: BeforeReplace): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // The check reads the target, which a sharing lock can hold as well.
      if (beforeReplace && !(await beforeReplace(destination))) throw new ReplaceDeclinedError();
      await rename(source, destination);
      return;
    } catch (error: unknown) {
      if (error instanceof ReplaceDeclinedError) throw error;
      if (process.platform !== "win32" || attempt >= 10 || !(error instanceof Error && "code" in error
        && typeof error.code === "string" && WINDOWS_SHARING_ERRORS.has(error.code))) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/** Thrown by writeAtomic when its `beforeReplace` check declines the replacement. */
export class ReplaceDeclinedError extends Error {
  constructor() {
    super("The file changed while its replacement was written.");
  }
}

/** Replace the real target after its complete replacement reaches disk, preserving symlinks
 *  and an existing target's permissions. A new file gets the default mode for the umask.
 *  Resolves with the modification time of the file written, which the rename keeps, so a
 *  write by another program right after it is not taken for this one. `beforeReplace` runs
 *  just before the rename, and again before a retry of it, with the real file the rename
 *  replaces, and a false answer leaves the target as it is and throws ReplaceDeclinedError. */
export async function writeAtomic(
  destination: string,
  bytes: Uint8Array | string,
  { beforeReplace }: { beforeReplace?: BeforeReplace } = {},
): Promise<number> {
  const requested = absolutePath(destination);
  const path = await realpath(requested).catch(async (error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const info = await lstat(requested).catch((statError: unknown) => {
      if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") return null;
      throw statError;
    });
    if (info?.isSymbolicLink()) throw new Error("The symbolic link's target does not exist.");
    return requested;
  });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const mode = await stat(path).then((info) => info.mode, () => undefined);
  const file = await open(temporary, "wx", mode);
  try {
    // The umask strips bits from the mode given to open. Windows has no umask.
    if (mode !== undefined && process.platform !== "win32") await file.chmod(mode & 0o7777);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    const { mtimeMs } = await stat(temporary);
    await renameAtomic(temporary, path, beforeReplace);
    return mtimeMs;
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** A file's bytes with the metadata of the very file they came from. */
interface FileVersion {
  bytes: Buffer;
  info: Stats;
}

/** Read the bytes and the metadata of one open file, so a replacement of the file in
 *  between cannot pair the old bytes with the new metadata. A program that rewrites the
 *  file in place while it is read changes its time or size, and the read starts again,
 *  up to READ_ATTEMPTS times, and then fails. */
async function readVersion(target: string): Promise<FileVersion> {
  for (let attempt = 1; ; attempt++) {
    const handle = await open(target, "r");
    let version: FileVersion;
    let settled: boolean;
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const info = await handle.stat();
      version = { bytes, info };
      settled = before.mtimeMs === info.mtimeMs && before.size === info.size && bytes.length === info.size;
    } finally {
      await handle.close();
    }
    if (settled) return version;
    if (attempt >= READ_ATTEMPTS) throw new Error("The file kept changing while it was read.");
  }
}

/** A Markdown file's text as the app keeps it: without a BOM and with LF line
 *  endings, with the line ending and BOM the file had. */
function decodeMarkdown(bytes: Buffer): Pick<FilePayload, "content" | "eol" | "hadBom"> {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(hadBom ? bytes.subarray(3) : bytes);
  } catch {
    throw new Error("The file is not valid UTF-8.");
  }
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf;
  return { content: raw.replace(/\r\n?/g, "\n"), eol: crlf > 0 && crlf >= lf ? "crlf" : "lf", hadBom };
}

export async function readMarkdown(path: string): Promise<FilePayload> {
  const { bytes, info } = await readVersion(absolutePath(path));
  return { ...decodeMarkdown(bytes), sizeBytes: bytes.length, modifiedMs: Math.floor(info.mtimeMs) };
}

/** How often a read starts again while another program rewrites the file in place. */
const READ_ATTEMPTS = 3;

/** Whether the real file at `target` holds `text`, as its LF form without a BOM, or is
 *  gone. A file that is not valid UTF-8 does not hold it. Once the text matches, the path
 *  must still name the very file read, with the time and size it had then, so a program
 *  that replaced the file during the read or the comparison is noticed. That look at the
 *  path is the last step, so it comes as close to the rename as it can. */
async function holdsText(target: string, text: string): Promise<boolean> {
  const missing = (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  };
  const version = await readVersion(target).catch(missing);
  if (!version) return true;
  let content: string;
  try {
    ({ content } = decodeMarkdown(version.bytes));
  } catch {
    return false;
  }
  if (content !== text) return false;
  const now = await stat(target).catch(missing);
  if (!now) return true;
  return now.dev === version.info.dev && now.ino === version.info.ino
    && now.mtimeMs === version.info.mtimeMs && now.size === version.info.size;
}

/** The file's modification time and size, which tell whether it changed without
 *  reading it. They come from an open file, as a network file system can answer a
 *  plain stat from attributes it cached earlier. */
export async function fileStamp(path: string): Promise<FileStamp> {
  const handle = await open(absolutePath(path), "r");
  try {
    const info = await handle.stat();
    return { modifiedMs: Math.floor(info.mtimeMs), sizeBytes: info.size };
  } finally {
    await handle.close();
  }
}

let pendingMarkdownWrite: Promise<void> = Promise.resolve();

/** Serialize document saves before path resolution so aliases cannot reorder writes.
 *  With `expectedContent`, the write replaces the file only while it still holds that
 *  text, as its LF form without a BOM, or is gone, and otherwise throws
 *  FILE_CHANGED_ON_DISK and leaves the file as it is. The text tells also a replacement
 *  that kept the file's time, and reading it revalidates a network file system's
 *  cached attributes. The check reads the real file that the write replaces, so a
 *  symbolic link that changes or goes meanwhile cannot point it at another file. */
export function writeMarkdown(path: string, content: string, eol: Eol, expectedContent?: string): Promise<FileMeta> {
  const result = pendingMarkdownWrite.then(async () => {
    if (eol !== "lf" && eol !== "crlf") throw new Error("Unsupported line ending.");
    const normalized = content.replace(/\r\n?/g, "\n");
    const text = eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
    const beforeReplace = expectedContent === undefined ? undefined : (target: string) => holdsText(target, expectedContent);
    try {
      const modifiedMs = await writeAtomic(path, text, { beforeReplace });
      return { modifiedMs: Math.floor(modifiedMs), sizeBytes: Buffer.byteLength(text) };
    } catch (error) {
      if (error instanceof ReplaceDeclinedError) throw new Error(FILE_CHANGED_ON_DISK);
      throw error;
    }
  });
  pendingMarkdownWrite = result.then(() => {}, () => {});
  return result;
}

export async function exists(path: string): Promise<boolean> {
  return stat(absolutePath(path)).then(() => true, () => false);
}

function attachmentsDirectory(docPath: string, folderName: string): string {
  const parent = dirname(absolutePath(docPath));
  if (!folderName || folderName.includes("\0") || isAbsolute(folderName)) {
    throw new Error("The attachments folder must be relative to the document.");
  }
  const directory = resolve(parent, folderName);
  const distance = relative(parent, directory);
  if (!distance || distance === ".." || distance.startsWith(`..${sep}`)) {
    throw new Error("The attachments folder must stay inside the document folder.");
  }
  return directory;
}

export async function ensureAttachmentsDirectory(docPath: string, folderName: string): Promise<string> {
  const directory = attachmentsDirectory(docPath, folderName);
  await mkdir(directory, { recursive: true });
  return directory;
}

let pendingAttachmentWrite: Promise<void> = Promise.resolve();
const UNSUPPORTED_LINK_ERRORS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/** Stage complete attachments, then publish without replacing existing names when hard links are supported. */
export function writeAttachment(
  docPath: string,
  folderName: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  const result = pendingAttachmentWrite.then(async () => {
    if (!fileName || fileName === "." || fileName === ".." || /[\\/\0]/.test(fileName)) {
      throw new Error("An attachment name must be a file name.");
    }
    const directory = await ensureAttachmentsDirectory(docPath, folderName);
    const extension = extname(fileName);
    const stem = basename(fileName, extension);
    const temporary = join(directory, `.attachment-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      for (let suffix = 0; ; suffix++) {
        const name = suffix === 0 ? fileName : `${stem}-${suffix}${extension}`;
        const destination = join(directory, name);
        try {
          await link(temporary, destination);
        } catch (error: unknown) {
          if (!(error instanceof Error && "code" in error)) throw error;
          if (error.code === "EEXIST") continue;
          if (typeof error.code !== "string" || !UNSUPPORTED_LINK_ERRORS.has(error.code)) throw error;
          // FAT/exFAT lack hard links. Serialize application writers and recheck
          // the name before rename. A separate process can still create it here.
          const occupied = await lstat(destination).then(() => true, (statError: unknown) => {
            if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") return false;
            throw statError;
          });
          if (occupied) continue;
          await rename(temporary, destination);
        }
        return `${folderName.replace(/\\/g, "/")}/${name}`;
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  });
  pendingAttachmentWrite = result.then(() => {}, () => {});
  return result;
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".ico": "image/x-icon",
};

export function imageMime(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}

export async function readImage(path: string): Promise<ImageBytes> {
  const file = await readFile(absolutePath(path));
  return { bytes: ipcBytes(file), mime: imageMime(path) ?? "application/octet-stream" };
}

/** A file's bytes ready for IPC, without copying a large file again. IPC and the
 *  context bridge send a typed array's whole backing buffer, so a buffer that
 *  holds exactly the file is passed on as it is, and one that `readFile` took
 *  from Node's shared pool (a file whose size the system reports as 0) is copied,
 *  so no other bytes from the main process reach the renderer. */
export function ipcBytes(file: Buffer): Uint8Array<ArrayBuffer> {
  const { buffer } = file;
  return buffer instanceof ArrayBuffer && file.byteOffset === 0 && file.byteLength === buffer.byteLength
    ? new Uint8Array(buffer)
    : new Uint8Array(file);
}
