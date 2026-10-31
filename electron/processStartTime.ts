import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Read a process creation identity that changes when its PID is reused.
 *  Windows helpers run as the same user, so their StartTime is readable.
 *  Null confirms that the process is absent. Lookup failures throw, since they
 *  cannot establish whether an installation has finished. Linux support lets
 *  integration tests exercise the same ownership check. */
export async function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await executeFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference = 'Stop'; try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString() } ` +
        "catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { 'missing' } else { throw } }"],
      { timeout: 5000, windowsHide: true });
      const ticks = stdout.trim();
      if (ticks === "missing") return null;
      if (!/^\d+$/.test(ticks)) throw new Error("The process lookup returned an invalid creation time.");
      return ticks;
    }
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      // The process name in parentheses can contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (!fields[19]) throw new Error("The process lookup returned an invalid creation time.");
      return `${boot.trim()}/${fields[19]}`;
    }
    throw new Error("Process creation time is unavailable on this platform.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "linux") return null;
    throw error;
  }
}
