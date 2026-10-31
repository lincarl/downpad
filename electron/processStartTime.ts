import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Read a process creation identity that changes when its PID is reused.
 *  Windows helpers run as the same user, so their StartTime is readable.
 *  Linux support lets integration tests exercise the same ownership check. */
export async function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await executeFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference = 'Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
      { timeout: 5000, windowsHide: true });
      const ticks = stdout.trim();
      return /^\d+$/.test(ticks) ? ticks : null;
    }
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      // The process name in parentheses can contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `${boot.trim()}/${fields[19]}` : null;
    }
    return null;
  } catch { return null; }
}
