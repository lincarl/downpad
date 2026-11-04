/** Explain Git and operating system failures without exposing raw process errors. */
export function formatGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  const text = `${code} ${message}`.trim();
  const host = /(?:https?:\/\/(?:[^@/\s]+@)?|@)([a-z0-9.-]+\.[a-z]{2,})/i.exec(text)?.[1];
  const server = host ?? "the server";
  if (text.includes("Git is turned off.")) {
    return "Git is turned off. Enable it in Settings > Git to use this action.";
  }
  if (/\bENAMETOOLONG\b|\bE2BIG\b|argument list too long|(?:file name|filename|command line) too long/i.test(text)) {
    return "Git could not complete this action because a file path or command was too long. Try this action in your Git tool. If it also fails, move the repository to a shorter folder path.";
  }
  if (/spawn(?:sync)? git(?:\.exe)? ENOENT|Git is not installed/i.test(text)) {
    return "Downpad could not find Git. Install Git, then restart Downpad.";
  }
  if (/please tell me who you are|unable to auto-detect email address|empty ident name/i.test(text)) {
    return 'Git does not know your name and email yet. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com" in a terminal, then try again.';
  }
  if (/protected branch|GH006|pre-receive hook declined|not allowed to push|permission to .* denied to/i.test(text)) {
    return `${server} does not let you upload to this branch. Ask the repository's owner for access.`;
  }
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/i.test(text)) {
    return `Git could not sign in to ${server}. Sign in with your Git tool, then try again.`;
  }
  if (/host key verification failed/i.test(text)) {
    return `Git could not verify ${server}'s identity. Check the SSH connection in your Git tool before trying again.`;
  }
  if (/could not resolve host|unable to access ['"]?https?:|failed to connect|connection timed out|network is unreachable|could not read from remote repository|connection refused|operation timed out/i.test(text)) {
    return `Downpad cannot reach ${server}. Check the internet connection, then try again.`;
  }
  if (/\bENOSPC\b|no space left on device|disk full/i.test(text)) {
    return "There is not enough free disk space to finish this Git action. Free some space, then try again.";
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied|access is denied/i.test(text)) {
    return "Downpad does not have permission to access a file or run Git. Check the repository's file permissions, then try again.";
  }
  if (/\bENOENT\b|no such file or directory/i.test(text)) {
    return "A file or folder needed for this Git action no longer exists. Reopen the document and try again.";
  }
  if (/index\.lock|unable to create .*\.lock/i.test(text)) {
    return "Another Git program is using this repository. Try again in a moment.";
  }
  if (/\bETIMEDOUT\b|did not finish in time|timed out/i.test(text)) {
    return "Git did not finish in time. Try again. If it keeps happening, check the repository in your Git tool.";
  }
  return "Downpad could not complete the Git action. Try again. If it keeps failing, check the repository in your Git tool.";
}
