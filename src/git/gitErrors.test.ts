import { describe, expect, it } from "vitest";
import { formatGitError } from "./gitErrors";

describe("formatGitError", () => {
  it("preserves the next step when Git is turned off", () => {
    expect(formatGitError(new Error("Error invoking remote method 'command'. Error: Git is turned off. Enable it in Settings > Git to use this action.")))
      .toBe("Git is turned off. Enable it in Settings > Git to use this action.");
  });

  it.each([
    new Error("spawn ENAMETOOLONG"),
    new Error("Error invoking remote method 'command'. Error: spawn E2BIG"),
    Object.assign(new Error("Could not start process"), { code: "E2BIG" }),
    "fatal: cannot create a file. Filename too long",
  ])("explains path and command length failures without showing process errors", (error) => {
    const message = formatGitError(error);
    expect(message).toContain("file path or command was too long");
    expect(message).toContain("Try this action in your Git tool");
    expect(message).not.toMatch(/spawn|ENAMETOOLONG|E2BIG/);
  });

  it("distinguishes a missing Git installation from a missing file", () => {
    expect(formatGitError(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })))
      .toContain("Install Git, then restart Downpad");
    expect(formatGitError(Object.assign(new Error("open '/work/notes.md'"), { code: "ENOENT" })))
      .toContain("Reopen the document");
  });

  it("explains common Git and file failures with the next step", () => {
    expect(formatGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"))
      .toBe("Git could not sign in to github.com. Sign in with your Git tool, then try again.");
    expect(formatGitError("ssh: Could not resolve hostname gitlab.example.org\nfatal: Could not read from remote repository."))
      .toMatch(/^Downpad cannot reach/);
    expect(formatGitError("remote: error: GH006: Protected branch update failed for refs/heads/main."))
      .toContain("Ask the repository's owner for access");
    expect(formatGitError("fatal: Host key verification failed"))
      .toContain("Check the SSH connection");
    expect(formatGitError(new Error("EACCES: permission denied")))
      .toContain("Check the repository's file permissions");
    expect(formatGitError("fatal: Unable to create '/work/.git/index.lock'. Permission denied"))
      .toContain("Check the repository's file permissions");
    expect(formatGitError(new Error("ENOSPC: no space left on device")))
      .toContain("Free some space");
  });

  it.each([new Error("unexpected internal process detail"), "", null, { bad: "payload" }])(
    "gives a safe fallback for unrecognized errors",
    (error) => {
      expect(formatGitError(error)).toBe("Downpad could not complete the Git action. Try again. If it keeps failing, check the repository in your Git tool.");
    },
  );
});
