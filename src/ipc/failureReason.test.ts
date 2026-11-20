import { describe, expect, it } from "vitest";
import { failureReason } from "./failureReason";

describe("the reason of a failure", () => {
  it.each([
    ["Error invoking remote method 'command': Error: EMFILE: too many open files, open '/docs/a.md'", "EMFILE: too many open files, open '/docs/a.md'"],
    ["Error invoking remote method 'command'. Error: Git is turned off.", "Git is turned off."],
    ["Error invoking remote method: TypeError: The path is not a file.", "The path is not a file."],
    ["Disk unavailable", "Disk unavailable"],
  ])("leaves Electron's prefix out of %s", (message, reason) => {
    expect(failureReason(new Error(message))).toBe(reason);
  });

  it.each([
    ["ENOENT: no such file or directory, open '/docs/gone/.a.md.1234.tmp'", "The file or folder does not exist."],
    ["Error invoking remote method 'command': Error: EACCES: permission denied, open '/docs/a.md'", "Permission was denied."],
    ["EPERM: operation not permitted, rename 'a' -> 'b'", "Permission was denied."],
    ["EROFS: read-only file system, open '/docs/a.md'", "The disk is read-only."],
    ["ENOSPC: no space left on device, write", "The disk is full."],
    ["EBUSY: resource busy or locked, rename 'a' -> 'b'", "Another program is using the file."],
  ])("gives a plain reason for %s", (message, reason) => {
    expect(failureReason(new Error(message))).toBe(reason);
  });

  it("takes a thrown string as it is, and anything else for no reason", () => {
    expect(failureReason("Disk unavailable")).toBe("Disk unavailable");
    expect(failureReason({ code: 5 })).toBe("");
    expect(failureReason(undefined)).toBe("");
  });
});
