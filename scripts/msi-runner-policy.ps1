#requires -Version 5.1
<#
.SYNOPSIS
Temporarily prevents Windows Installer from shutting down hosted runner processes.
.DESCRIPTION
Enable saves the original policy value before setting it to DWORD 1. Restore
uses that snapshot, including after a partially failed Enable. Both operations
require a GitHub-hosted Windows runner unless an isolated test key is supplied.
Keep StatePath under the current checkout's dev-temp directory. Snapshots remain
available for diagnostics and cannot be overwritten by another Enable.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Enable', 'Restore')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$TestKeyId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'The MSI runner policy requires Windows.' }
if (-not $TestKeyId -and ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted')) {
    throw 'Machine policy changes require a GitHub-hosted Actions runner.'
}
$stateFile = [IO.Path]::GetFullPath($StatePath)
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath 'dev-temp')) + [IO.Path]::DirectorySeparatorChar
if (-not $stateFile.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The policy snapshot must be under the current checkout dev-temp directory.'
}
if ($Operation -eq 'Restore' -and -not [IO.File]::Exists($stateFile)) {
    if (Test-Path -LiteralPath $stateFile) { throw 'The policy snapshot is not a file.' }
    Write-Host 'No policy snapshot exists. Enable did not save a change to restore.'
    return
}
if (-not $TestKeyId) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Machine policy changes require an administrator.'
        }
    } finally { $identity.Dispose() }
}
$hive = if ($TestKeyId) { 'CurrentUser' } else { 'LocalMachine' }
$subKey = if ($TestKeyId) { "Software\DownpadMsiRunnerPolicyTests\$TestKeyId" } else { 'Software\Policies\Microsoft\Windows\Installer' }
$valueName = 'DisableAutomaticApplicationShutdown'

# Encode registry data without expanding environment strings or losing integer precision.
function Read-PolicyValue([Microsoft.Win32.RegistryKey]$Key) {
    $value = [ordered]@{ existed = $false; kind = $null; data = $null }
    if ($Key -and $Key.GetValueNames() -contains $valueName) {
        $value.existed = $true
        $value.kind = [string]$Key.GetValueKind($valueName)
        $raw = $Key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $value.data = switch ($value.kind) {
            'DWord' { $raw.ToString([Globalization.CultureInfo]::InvariantCulture) }
            'QWord' { $raw.ToString([Globalization.CultureInfo]::InvariantCulture) }
            'Binary' { [Convert]::ToBase64String($raw) }
            'None' { [Convert]::ToBase64String($raw) }
            'String' { $raw }
            'ExpandString' { $raw }
            'MultiString' { ,([string[]]$raw) }
            default { throw "Cannot preserve registry value kind $($value.kind)." }
        }
    }
    return $value
}

# Accept only the exact snapshot target and data forms produced by Enable.
function Read-PolicySnapshot {
    $snapshot = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
    $fields = @('version', 'hive', 'subKey', 'valueName', 'existed', 'kind', 'data')
    if (-not $snapshot -or @($snapshot.PSObject.Properties).Count -ne $fields.Count) { throw 'Invalid policy snapshot fields.' }
    foreach ($field in $fields) {
        if ($snapshot.PSObject.Properties.Name -cnotcontains $field) { throw 'Invalid policy snapshot fields.' }
    }
    if (($snapshot.version -isnot [int] -and $snapshot.version -isnot [long]) -or $snapshot.version -ne 1 -or
        $snapshot.hive -cne $hive -or $snapshot.subKey -cne $subKey -or
        $snapshot.valueName -cne $valueName -or $snapshot.existed -isnot [bool]) {
        throw 'The policy snapshot does not match this operation.'
    }
    if (-not $snapshot.existed) {
        if ($null -ne $snapshot.kind -or $null -ne $snapshot.data) { throw 'Invalid absent-value snapshot.' }
        return @{ snapshot = $snapshot; value = $null }
    }
    if ($snapshot.kind -ceq 'MultiString') {
        if ($snapshot.data -isnot [array] -or @($snapshot.data | Where-Object { $_ -isnot [string] }).Count -gt 0) {
            throw 'Invalid multi-string policy snapshot.'
        }
        return @{ snapshot = $snapshot; value = [string[]]$snapshot.data }
    }
    if ($snapshot.data -isnot [string]) { throw 'Invalid policy snapshot data.' }
    $decoded = switch -CaseSensitive ($snapshot.kind) {
        'DWord' { [int]::Parse($snapshot.data, [Globalization.CultureInfo]::InvariantCulture) }
        'QWord' { [long]::Parse($snapshot.data, [Globalization.CultureInfo]::InvariantCulture) }
        'Binary' { ,([Convert]::FromBase64String($snapshot.data)) }
        'None' { ,([Convert]::FromBase64String($snapshot.data)) }
        'String' { $snapshot.data }
        'ExpandString' { $snapshot.data }
        default { throw 'Invalid policy snapshot kind.' }
    }
    if ($snapshot.kind -in @('DWord', 'QWord') -and $decoded.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $snapshot.data) {
        throw 'Invalid integer policy snapshot.'
    }
    if ($snapshot.kind -in @('Binary', 'None') -and [Convert]::ToBase64String($decoded) -cne $snapshot.data) {
        throw 'Invalid binary policy snapshot.'
    }
    return @{ snapshot = $snapshot; value = $decoded }
}

# Retain the installer mutex until restoration finishes. Never stop its service.
function Lock-IdleInstaller {
    try {
        $rights = [Security.AccessControl.MutexRights]::Synchronize -bor [Security.AccessControl.MutexRights]::Modify
        $mutex = [Threading.Mutex]::OpenExisting('Global\_MSIExecute', $rights)
    } catch [Threading.WaitHandleCannotBeOpenedException] { return $null }
    try {
        try { $acquired = $mutex.WaitOne(60000) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Windows Installer is still busy. The temporary runner policy remains enabled.' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]::Registry64)
$key = $null
$installerMutex = $null
try {
    $key = $base.OpenSubKey($subKey)
    if ($TestKeyId -and (-not $key -or $key.GetValue('DownpadPolicyTest') -cne $TestKeyId)) {
        throw 'The isolated test key must already exist with its matching marker.'
    }
    if ($Operation -eq 'Enable') {
        $original = Read-PolicyValue $key
        $snapshot = [ordered]@{ version = 1; hive = $hive; subKey = $subKey; valueName = $valueName
            existed = $original.existed; kind = $original.kind; data = $original.data }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stateFile))
        # CreateNew refuses even a second Enable after a partial failure.
        $stream = New-Object IO.FileStream($stateFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Depth 4))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        if ($key) { $key.Dispose(); $key = $null }
        $key = $base.CreateSubKey($subKey)
        $key.SetValue($valueName, 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        if ($key.GetValueKind($valueName) -ne [Microsoft.Win32.RegistryValueKind]::DWord -or $key.GetValue($valueName) -ne 1) {
            throw 'Could not verify the enabled MSI runner policy.'
        }
        Write-Host 'Disabled automatic application shutdown for this MSI test runner.'
    } else {
        $saved = Read-PolicySnapshot
        if (-not $TestKeyId) { $installerMutex = Lock-IdleInstaller }
        if ($key) { $key.Dispose(); $key = $null }
        $key = if ($saved.snapshot.existed) { $base.CreateSubKey($subKey) } else { $base.OpenSubKey($subKey, $true) }
        if ($saved.snapshot.existed) {
            $key.SetValue($valueName, $saved.value, [Microsoft.Win32.RegistryValueKind]$saved.snapshot.kind)
        } elseif ($key) { $key.DeleteValue($valueName, $false) }
        $restored = Read-PolicyValue $key
        $expected = [ordered]@{ existed = $saved.snapshot.existed; kind = $saved.snapshot.kind; data = $saved.snapshot.data }
        if (($restored | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) {
            throw 'Could not verify restoration of the original MSI runner policy.'
        }
        Write-Host 'Restored the original MSI runner policy value. Sibling values and the registry key were preserved.'
    }
} finally {
    if ($key) { $key.Dispose() }
    $base.Dispose()
    if ($installerMutex) { $installerMutex.ReleaseMutex(); $installerMutex.Dispose() }
}
