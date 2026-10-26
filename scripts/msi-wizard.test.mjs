import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { powershellInvocation } from "./run-msi-test.mjs";

const execute = promisify(execFile);
const wizardScript = fileURLToPath(new URL("./msi-wizard.ps1", import.meta.url));
// CI runs the MSI tests with Windows PowerShell 5.1. Linux runners have pwsh.
const shell = process.platform === "win32"
  ? powershellInvocation([]).command
  : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "pwsh")).find((file) => existsSync(file));
const options = { skip: !shell && !process.env.CI ? "PowerShell 7 (pwsh) is not on PATH" : false };

// Feeds each case's window snapshots to one wizard state. A thrown error ends
// that case, as it ends the real MSI test.
const harness = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
. $env:DOWNPAD_WIZARD_SCRIPT
$start = [datetime]'2026-01-01T00:00:00'
$isChecked = { param($control) [int]$control.Checked }
$cases = @(($env:DOWNPAD_WIZARD_CASES | ConvertFrom-Json).cases)
for ($index = 0; $index -lt $cases.Count; $index++) {
    $state = New-WizardState $start
    foreach ($step in @($cases[$index].steps)) {
        $result = @{ case = $index; action = $null; target = $null; error = $null }
        try {
            $choice = Select-WizardAction $state @($step.windows) $isChecked $start.AddSeconds($step.at)
            if ($choice) { $result.action = $choice.Action; $result.target = $choice.Target.Handle }
        } catch { $result.error = $_.Exception.Message }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
        if ($result.error) { break }
    }
}
`;

/** Replays the cases in PowerShell. Each case lists "wait", "action -> handle", or "error: first line". */
async function replay(...cases) {
  assert.ok(shell, "CI must provide PowerShell to replay the MSI wizard.");
  const run = execute(shell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64"),
  ], {
    env: { ...process.env, DOWNPAD_WIZARD_SCRIPT: wizardScript, DOWNPAD_WIZARD_CASES: JSON.stringify({ cases: cases.map((steps) => ({ steps })) }) },
    timeout: 60_000,
    windowsHide: true,
  });
  // Windows PowerShell can wait for redirected input before it exits.
  run.child.stdin.end();
  const { stdout } = await run;
  const results = cases.map(() => []);
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const { case: index, action, target, error } = JSON.parse(line);
    results[index].push(error ? `error: ${error.split(/\r?\n/)[0]}` : action ? `${action} -> ${target}` : "wait");
  }
  return results;
}

// Snapshots follow the WiX dialogs and window dumps from CI. A dialog's
// controls use handles after the dialog's own handle.
const control = (handle, className, text, { enabled = true, checked = 0 } = {}) => ({ Handle: handle, ClassName: className, Text: text, Enabled: enabled, Checked: checked });
const dialog = (handle, controls) => ({ Handle: handle, Text: "Downpad Setup", Children: controls.map((item, index) => control(handle + index + 1, ...item)) });
const prepare = dialog(10, [["Button", "&Back", { enabled: false }], ["Button", "&Next", { enabled: false }], ["Button", "Cancel"], ["Static", "Please wait while the Setup Wizard prepares to guide you through the installation."]]);
const welcome = dialog(20, [["Button", "&Next"], ["Button", "Cancel"], ["Button", "&Back", { enabled: false }], ["Static", "Welcome to the Downpad Setup Wizard"]]);
const scope = (perUser) => dialog(30, [
  ["Button", "Install &just for you (runneradmin)", { checked: perUser }],
  ["Button", "Install for all &users of this machine", { checked: 1 - perUser }],
  ["Button", "&Back"], ["Button", "&Next"], ["Button", "Cancel"], ["Static", "Installation Scope"],
]);
const ready = dialog(40, [["Button", "&Install"], ["Button", "Cancel"], ["Button", "&Back"], ["Static", "Ready to install Downpad"]]);
const progress = dialog(50, [["Button", "&Back", { enabled: false }], ["Button", "&Next", { enabled: false }], ["Button", "Cancel"], ["Static", "Installing Downpad"]]);
const exit = (run, controls = [["Button", "Run Downpad", { checked: run }]]) => dialog(60, [
  ["Button", "&Finish"], ["Button", "Cancel", { enabled: false }], ["Button", "&Back", { enabled: false }], ...controls, ["Static", "Completed the Downpad Setup Wizard"],
]);
const at = (seconds, ...windows) => ({ at: seconds, windows });

test("a dialog that received Next is not read again while Windows Installer replaces it", options, async () => {
  // Recorded on 2026-10-26: the closing scope dialog read as unchecked, and the
  // old driver posted a scope click to a destroyed radio button. A passing
  // upgrade showed the Exit and Progress dialogs together.
  const [fresh] = await replay([
    at(0, prepare), at(1, welcome), at(1.2, welcome), at(2, scope(1)), at(2.6, scope(0)),
    at(2.8, scope(0), ready), at(3, ready), at(4, progress), at(8, exit(1), progress), at(8.5, exit(1)),
  ]);
  assert.deepEqual(fresh, [
    "wait", "Next on dialog 20 -> 21", "wait", "Next on dialog 30 -> 34", "wait",
    "Install -> 41", "wait", "wait", "Finish with Run Downpad checked -> 61", "wait",
  ]);
});

test("the per-user scope and Run Downpad are checked before Next and Finish", options, async () => {
  const [choices] = await replay([
    at(0, welcome), at(1, scope(0)), at(1.2, scope(0)), at(1.5, scope(1)), at(2, ready), at(5, exit(0)), at(5.5, exit(0)), at(6, exit(1)),
  ]);
  assert.deepEqual(choices, [
    "Next on dialog 20 -> 21", "select per-user installation -> 31", "wait", "Next on dialog 30 -> 34",
    "Install -> 41", "check Run Downpad -> 64", "wait", "Finish with Run Downpad checked -> 61",
  ]);
});

test("a click without effect fails after 20 seconds", options, async () => {
  const [closing, scopeClick] = await replay(
    [at(0, welcome), at(19, welcome), at(20.5, welcome)],
    [at(0, welcome), at(1, scope(0)), at(21.5, scope(0))],
  );
  assert.deepEqual(closing, ["Next on dialog 20 -> 21", "wait", "error: Installer did not respond to 'Next on dialog 20'."]);
  assert.deepEqual(scopeClick, ["Next on dialog 20 -> 21", "select per-user installation -> 31", "error: Installer did not respond to 'select per-user installation'."]);
});

test("installer errors and modals fail even while a dialog is closing", options, async () => {
  const failure = dialog(70, [["Button", "OK"], ["Static", "The installer has encountered an unexpected error installing this package."]]);
  const cancel = dialog(80, [["Button", "&Yes"], ["Button", "&No"], ["Static", "Are you sure you want to cancel Downpad installation?"]]);
  const [error, modal] = await replay(
    [at(0, welcome), at(0.5, welcome, failure)],
    [at(0, welcome), at(1, ready), at(1.5, cancel, ready)],
  );
  assert.deepEqual(error, ["Next on dialog 20 -> 21", "error: Installer error dialog after 'Next on dialog 20'."]);
  assert.deepEqual(modal, ["Next on dialog 20 -> 21", "Install -> 41", "error: Unexpected installer modal dialog."]);
});

test("Finish requires the Welcome and Install steps and a Run Downpad checkbox", options, async () => {
  const [skipped, missing] = await replay(
    [at(0, exit(1))],
    [at(0, welcome), at(1, ready), at(5, exit(0, []))],
  );
  assert.deepEqual(skipped, ["error: Reached Finish without Welcome and Install."]);
  assert.deepEqual(missing, ["Next on dialog 20 -> 21", "Install -> 41", "error: Exit dialog does not offer Run Downpad."]);
});
