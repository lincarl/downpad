import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { powershellInvocation } from "./run-msi-test.mjs";

const execute = promisify(execFile);
const policyScript = fileURLToPath(new URL("./msi-runner-policy.ps1", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const shell = process.platform === "win32"
  ? powershellInvocation([]).command
  : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "pwsh")).find((file) => existsSync(file));
const native = { skip: process.platform !== "win32" ? "Real registry lifecycle tests require Windows" : false };

/** Run an isolated registry fixture with its snapshots inside the checkout. */
async function runPowerShell(body) {
  assert.ok(shell, "CI must provide PowerShell to validate the runner policy.");
  const directory = path.join(root, "dev-temp", "msi-runner-policy-tests");
  await mkdir(directory, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(directory, "case-"));
  try {
    const run = execute(shell, [
      "-NoLogo", "-NoProfile", "-NonInteractive",
      ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
      "-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n${body}`, "utf16le").toString("base64"),
    ], {
      cwd: root,
      env: { ...process.env, DOWNPAD_POLICY_SCRIPT: policyScript, DOWNPAD_POLICY_TEST_DIRECTORY: stateDirectory },
      timeout: 60_000,
      windowsHide: true,
    });
    run.child.stdin.end();
    return await run;
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
}

const registryFixture = `
$id = [guid]::NewGuid().ToString('N')
$subKey = "Software\\DownpadMsiRunnerPolicyTests\\$id"
$name = 'DisableAutomaticApplicationShutdown'
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$key = $base.CreateSubKey($subKey)
$key.SetValue('DownpadPolicyTest', $id, [Microsoft.Win32.RegistryValueKind]::String)
$key.SetValue('Sibling', 'preserve me', [Microsoft.Win32.RegistryValueKind]::String)
function Assert-Policy($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-Policy([string]$Operation, [string]$StatePath) {
    & $env:DOWNPAD_POLICY_SCRIPT -Operation $Operation -StatePath $StatePath -TestKeyId $id
}
function Assert-PolicyFailure([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert-Policy $failed 'Expected the policy operation to fail.'
}
`;
const registryCleanup = `
} finally {
    $key.Dispose()
    $base.DeleteSubKeyTree($subKey, $false)
    $base.Dispose()
}
'Policy tests passed'
`;

test("the runner policy parses and rejects unsupported operating systems", { skip: !shell && !process.env.CI ? "PowerShell is not on PATH" : false }, async () => {
  await runPowerShell(`
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($env:DOWNPAD_POLICY_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    $failed = $false
    try { & $env:DOWNPAD_POLICY_SCRIPT -Operation Enable -StatePath (Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'unsupported.json') }
    catch { $failed = $_.Exception.Message -like '*requires Windows*' }
    if (-not $failed) { throw 'The policy operation accepted an unsupported operating system.' }
}
`);
});

test("Enable and Restore preserve absent values, registry kinds, data, and sibling values", native, async () => {
  const { stdout } = await runPowerShell(`${registryFixture}
try {
    $cases = @(
        @{ kind = $null; value = $null },
        @{ kind = 'DWord'; value = 0 }, @{ kind = 'DWord'; value = 1 }, @{ kind = 'DWord'; value = 2 },
        @{ kind = 'DWord'; value = [int]-1 }, @{ kind = 'QWord'; value = [long]::MaxValue },
        @{ kind = 'String'; value = 'original policy' }, @{ kind = 'ExpandString'; value = '%TEMP%\\original' },
        @{ kind = 'Binary'; value = [byte[]]@(0, 1, 255) }, @{ kind = 'None'; value = [byte[]]@() },
        @{ kind = 'MultiString'; value = [string[]]@('first', 'second') }, @{ kind = 'MultiString'; value = [string[]]@() }
    )
    for ($index = 0; $index -lt $cases.Count; $index++) {
        $case = $cases[$index]
        $key.DeleteValue($name, $false)
        if ($case.kind) { $key.SetValue($name, $case.value, [Microsoft.Win32.RegistryValueKind]$case.kind) }
        $state = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY "$index.json"
        Invoke-Policy Enable $state
        Assert-Policy ($key.GetValueKind($name) -eq [Microsoft.Win32.RegistryValueKind]::DWord -and $key.GetValue($name) -eq 1) 'Policy was not enabled.'
        $snapshot = [IO.File]::ReadAllText($state)
        Assert-PolicyFailure { Invoke-Policy Enable $state }
        Assert-Policy ([IO.File]::ReadAllText($state) -ceq $snapshot) 'Repeated Enable replaced the original snapshot.'
        Invoke-Policy Restore $state
        Invoke-Policy Restore $state
        Assert-Policy ($key.GetValue('Sibling') -ceq 'preserve me') 'Restore changed a sibling value.'
        Assert-Policy ($key.GetValue('DownpadPolicyTest') -ceq $id) 'Restore removed the test key or marker.'
        if ($case.kind) {
            Assert-Policy ([string]$key.GetValueKind($name) -ceq $case.kind) 'The original registry kind was not restored.'
            $actual = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Assert-Policy ((ConvertTo-Json -InputObject $actual -Compress) -ceq (ConvertTo-Json -InputObject $case.value -Compress)) 'The original registry data was not restored.'
        } else { Assert-Policy ($key.GetValueNames() -notcontains $name) 'An originally absent value remains present.' }
    }
${registryCleanup}`);
  assert.match(stdout, /Policy tests passed/);
});

test("Restore rejects corrupt or foreign snapshots and treats a missing snapshot as no change", native, async () => {
  const { stdout } = await runPowerShell(`${registryFixture}
try {
    $key.SetValue($name, 0, [Microsoft.Win32.RegistryValueKind]::DWord)
    $missing = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'missing.json'
    Invoke-Policy Restore $missing
    Assert-Policy ($key.GetValue($name) -eq 0) 'Missing-snapshot restore changed the policy.'
    $state = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'original.json'
    Invoke-Policy Enable $state
    $original = [IO.File]::ReadAllText($state)
    $invalid = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'invalid.json'
    foreach ($change in @(
        { param($saved) $saved.hive = 'LocalMachine' },
        { param($saved) $saved.subKey = 'Software\\Other' },
        { param($saved) $saved.valueName = 'Sibling' },
        { param($saved) $saved.kind = 'Unknown' },
        { param($saved) $saved.data = 'invalid' },
        { param($saved) $saved.data = '01' },
        { param($saved) $saved.existed = $false },
        { param($saved) $saved.PSObject.Properties.Remove('data') }
    )) {
        $saved = $original | ConvertFrom-Json
        & $change $saved
        [IO.File]::WriteAllText($invalid, ($saved | ConvertTo-Json))
        Assert-PolicyFailure { Invoke-Policy Restore $invalid }
        Assert-Policy ($key.GetValue($name) -eq 1 -and $key.GetValue('Sibling') -ceq 'preserve me') 'Invalid snapshot changed registry data.'
    }
    [IO.File]::WriteAllText($invalid, '{broken JSON')
    Assert-PolicyFailure { Invoke-Policy Restore $invalid }
    Assert-Policy ($key.GetValue($name) -eq 1) 'Corrupt snapshot changed the policy.'
    $key.SetValue('DownpadPolicyTest', 'wrong marker', [Microsoft.Win32.RegistryValueKind]::String)
    Assert-PolicyFailure { Invoke-Policy Restore $state }
    $key.SetValue('DownpadPolicyTest', $id, [Microsoft.Win32.RegistryValueKind]::String)
    Invoke-Policy Restore $state
${registryCleanup}`);
  assert.match(stdout, /Policy tests passed/);
});

test("an Enable write failure retains the original snapshot for Restore", native, async () => {
  const { stdout } = await runPowerShell(`${registryFixture}
$control = $base.OpenSubKey($subKey, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::FullControl)
$accessSection = [Security.AccessControl.AccessControlSections]::Access
$originalAcl = $control.GetAccessControl($accessSection).GetSecurityDescriptorBinaryForm()
function Restore-TestAccess {
    # SetAccessControl persists only modified sections. Reusing the unmodified
    # GetAccessControl result would leave the injected deny rule in place.
    $restoredAcl = New-Object Security.AccessControl.RegistrySecurity
    $restoredAcl.SetSecurityDescriptorBinaryForm($originalAcl, $accessSection)
    $control.SetAccessControl($restoredAcl)
    $readback = $control.GetAccessControl($accessSection).GetSecurityDescriptorSddlForm($accessSection)
    Assert-Policy ($readback -ceq $restoredAcl.GetSecurityDescriptorSddlForm($accessSection)) 'The original test-key access rules were not restored.'
}
try {
    $key.SetValue($name, 2, [Microsoft.Win32.RegistryValueKind]::DWord)
    $blockedAcl = New-Object Security.AccessControl.RegistrySecurity
    $blockedAcl.SetSecurityDescriptorBinaryForm($originalAcl, $accessSection)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $deny = New-Object Security.AccessControl.RegistryAccessRule($user, [Security.AccessControl.RegistryRights]::SetValue, [Security.AccessControl.AccessControlType]::Deny)
    $blockedAcl.AddAccessRule($deny)
    $control.SetAccessControl($blockedAcl)
    $state = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'write-failure.json'
    try {
        Assert-PolicyFailure { Invoke-Policy Enable $state }
        Assert-Policy ([IO.File]::Exists($state)) 'Enable did not save the snapshot before its failed write.'
        Assert-Policy ($key.GetValue($name) -eq 2) 'The rejected write changed the original value.'
    } finally { Restore-TestAccess }
    Invoke-Policy Restore $state
    Assert-Policy ($key.GetValue($name) -eq 2) 'Restore lost the value saved before the failed Enable.'
} finally {
    Restore-TestAccess
    $control.Dispose()
    $key.Dispose()
    $base.DeleteSubKeyTree($subKey, $false)
    $base.Dispose()
}
'Policy tests passed'
`);
  assert.match(stdout, /Policy tests passed/);
});

test("machine policy refuses non-hosted environments without touching the registry", native, async () => {
  const { stdout } = await runPowerShell(`
$state = Join-Path $env:DOWNPAD_POLICY_TEST_DIRECTORY 'never-created.json'
foreach ($environment in @(@('false', 'github-hosted'), @('true', 'self-hosted'))) {
    $env:GITHUB_ACTIONS = $environment[0]
    $env:RUNNER_ENVIRONMENT = $environment[1]
    $failed = $false
    try { & $env:DOWNPAD_POLICY_SCRIPT -Operation Restore -StatePath $state }
    catch { $failed = $_.Exception.Message -like '*GitHub-hosted*' }
    if (-not $failed) { throw 'A non-hosted environment bypassed the policy guard.' }
}
'Policy tests passed'
`);
  assert.match(stdout, /Policy tests passed/);
});
