#requires -Version 5.1
<#
.SYNOPSIS
Tests a Downpad MSI's installed payload and the wizard's Run Downpad action.
.DESCRIPTION
Run from the source checkout in an interactive Windows test account with no
existing Downpad installation.
Without PreviousMsi, first checks silent installation and removal, then a fresh
wizard installation. With PreviousMsi, silently installs that package before
driving the current package's upgrade wizard. Never launches Downpad manually.
RecoverMissingExecutable requires equal product versions and removes only the
previous test installation's executable before the upgrade, simulating damage.
Diagnostics and isolated app data remain under dev-temp/msi-tests/diagnostics.
Use run-msi-test.mjs to enforce a separate process deadline around native calls.
.EXAMPLE
node scripts/run-msi-test.mjs -Msi release/Downpad-0.0.0-win-x64.msi -ExpectedExecutable release/win-unpacked/Downpad.exe -ExpectedVersion 0.0.0.0 -Scenario fresh
.EXAMPLE
node scripts/run-msi-test.mjs -PreviousMsi dev-temp/msi-tests/stable/Downpad-0.0.1-win-x64.msi -Msi dev-temp/msi-tests/candidate/Downpad-0.0.2-rc1-win-x64.msi -ExpectedExecutable dev-temp/msi-tests/candidate/win-unpacked/Downpad.exe -ExpectedVersion 0.0.2.0 -Scenario upgrade
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Msi,
    [string]$PreviousMsi,
    [switch]$RecoverMissingExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+\.\d+$')][string]$ExpectedVersion,
    [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Scenario = 'fresh',
    [ValidateRange(30, 600)][int]$TimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($RecoverMissingExecutable -and -not $PreviousMsi) { throw 'Recovery testing requires PreviousMsi.' }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'MSI integration tests require Windows.' }
if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
    throw 'MSI integration tests require an interactive desktop, not a Session 0 service.'
}

# Load this helper from workflow-controls while retaining diagnostics in the
# source checkout. Create them before native initialization or COM activation.
$diagnostics = Join-Path (Get-Location).ProviderPath ('dev-temp\msi-tests\diagnostics\{0}-{1}-{2}' -f $Scenario, (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
[void](New-Item -ItemType Directory -Path $diagnostics)
function Write-TestProgress([string]$Message, [switch]$Quiet) {
    # Flush each checkpoint so a supervisor timeout preserves the last operation.
    $line = '[{0}] {1}' -f [DateTime]::UtcNow.ToString('o'), $Message
    Add-Content -LiteralPath (Join-Path $diagnostics 'progress.log') -Value $line -Encoding UTF8
    if (-not $Quiet) { Write-Host $line }
}
Write-TestProgress "Initialize native helpers for '$Scenario', worker PID $PID"

# Native button messages are asynchronous, so an error modal cannot block the
# polling loop as a synchronous UIAutomation InvokePattern.Invoke can.
if (-not ('DownpadMsiTest.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace DownpadMsiTest {
    public sealed class Window {
        public IntPtr Handle;
        public string Text;
        public string ClassName;
        public bool Enabled;
    }
    public static class Native {
        private delegate bool EnumWindowProc(IntPtr handle, IntPtr state);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr state);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr state);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr handle);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] private static extern IntPtr ReadText(IntPtr handle, uint message, IntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        public static bool HasDesktop() {
            IntPtr desktop = OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero) return false;
            CloseDesktop(desktop);
            return true;
        }
        private static Window Read(IntPtr handle) {
            var text = new StringBuilder(4096);
            var name = new StringBuilder(256);
            GetWindowText(handle, text, text.Capacity);
            if (text.Length == 0) {
                UIntPtr result;
                ReadText(handle, 0x000D, new IntPtr(text.Capacity), text, 2, 200, out result);
            }
            GetClassName(handle, name, name.Capacity);
            return new Window { Handle = handle, Text = text.ToString(), ClassName = name.ToString(), Enabled = IsWindowEnabled(handle) };
        }
        public static Window[] Windows(int processId) {
            var windows = new List<Window>();
            EnumWindows(delegate(IntPtr handle, IntPtr state) {
                uint owner;
                GetWindowThreadProcessId(handle, out owner);
                if (owner == processId && IsWindowVisible(handle)) windows.Add(Read(handle));
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }
        public static Window[] Children(IntPtr parent) {
            var children = new List<Window>();
            EnumChildWindows(parent, delegate(IntPtr handle, IntPtr state) {
                if (IsWindowVisible(handle)) children.Add(Read(handle));
                return true;
            }, IntPtr.Zero);
            return children.ToArray();
        }
        public static int Checked(IntPtr handle) {
            UIntPtr result;
            if (SendMessageTimeout(handle, 0x00F0, IntPtr.Zero, IntPtr.Zero, 2, 1000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("The installer checkbox did not respond.");
            return (int)result.ToUInt32();
        }
        public static void Click(IntPtr handle) {
            SetForegroundWindow(GetAncestor(handle, 2));
            if (!PostMessage(handle, 0x00F5, IntPtr.Zero, IntPtr.Zero))
                throw new InvalidOperationException("Could not post the installer button click.");
        }
    }
}
'@
}
if (-not [DownpadMsiTest.Native]::HasDesktop()) { throw 'The Windows input desktop is unavailable or locked.' }

Write-TestProgress 'Resolve and hash packaged files'
$Msi = (Resolve-Path -LiteralPath $Msi).Path
$ExpectedExecutable = (Resolve-Path -LiteralPath $ExpectedExecutable).Path
if ($PreviousMsi) { $PreviousMsi = (Resolve-Path -LiteralPath $PreviousMsi).Path }
$expectedAsar = Join-Path (Split-Path -Parent $ExpectedExecutable) 'resources\app.asar'
if (-not (Test-Path -LiteralPath $expectedAsar -PathType Leaf)) { throw "Missing built app payload $expectedAsar" }
$expectedHash = (Get-FileHash -LiteralPath $ExpectedExecutable -Algorithm SHA256).Hash
$expectedAsarHash = (Get-FileHash -LiteralPath $expectedAsar -Algorithm SHA256).Hash
$installer = $null
$installFolder = Join-Path $env:LOCALAPPDATA 'Programs\Downpad'
$installedExe = Join-Path $installFolder 'Downpad.exe'
$startedProcesses = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$appProcesses = @{}
$attemptedProducts = New-Object 'System.Collections.Generic.List[string]'
$testStarted = Get-Date
$oldDataDir = $env:DOWNPAD_USER_DATA_DIR
$oldUpdateUrl = $env:DOWNPAD_UPDATE_API_URL
$failure = $null
$cleanupFailures = New-Object 'System.Collections.Generic.List[string]'

function ConvertTo-NumericVersion([string]$Version) {
    # MSI accepts a missing fourth component. PE fields always contain four.
    $parsed = [version]$Version
    return '{0}.{1}.{2}.{3}' -f $parsed.Major, $parsed.Minor, [Math]::Max(0, $parsed.Build), [Math]::Max(0, $parsed.Revision)
}

function Get-PeVersion([string]$Path) {
    # FileVersion is a display string and can hide an incorrect numeric resource.
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    return '{0}.{1}.{2}.{3}' -f $version.FileMajorPart, $version.FileMinorPart, $version.FileBuildPart, $version.FilePrivatePart
}

function Get-MsiMetadata([string]$Path) {
    # Opening the MSI database read-only does not install or repair the product.
    Write-TestProgress "Read MSI metadata from $Path"
    $database = $installer.OpenDatabase($Path, 0)
    $view = $null
    try {
        $result = @{}
        $view = $database.OpenView('SELECT `Property`, `Value` FROM `Property`')
        # Discard COM method results so callers receive only the metadata table.
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            $result[$record.StringData(1)] = $record.StringData(2)
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
        }
        [void]$view.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
        $view = $null
        $view = $database.OpenView('SELECT `Version` FROM `File` WHERE `File` = ''mainExecutable''')
        [void]$view.Execute()
        $record = $view.Fetch()
        if (-not $record) { throw "No mainExecutable row in $Path" }
        $result.ExecutableVersion = $record.StringData(1)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
        if ($result.ProductName -ne 'Downpad') { throw "Expected a Downpad MSI, found '$($result.ProductName)'" }
        foreach ($key in @('ProductCode', 'UpgradeCode')) {
            if ($result[$key] -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { throw "Invalid $key in $Path" }
        }
        return $result
    } finally {
        if ($view) { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
        Write-TestProgress "Released MSI database for $Path"
    }
}

function Get-RelatedProducts {
    # WindowsInstaller COM enumerates registrations without Win32_Product repairs.
    Write-TestProgress 'Enumerate related product registrations'
    foreach ($code in $installer.RelatedProducts($current.UpgradeCode)) { [string]$code }
    Write-TestProgress 'Finished enumerating related products'
}

function Assert-Installed($Metadata, [string]$Version, [switch]$CurrentPayload) {
    # Require the updater's registry path and a single fully installed product.
    Write-TestProgress "Verify installed product $($Metadata.ProductCode)"
    $folder = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Downpad' -Name InstallDir).InstallDir
    if ($folder.TrimEnd('\') -ine $installFolder) { throw "InstallDir is '$folder', expected '$installFolder'" }
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw "Missing $installedExe" }
    $actual = Get-PeVersion $installedExe
    if ($actual -ne $Version) { throw "Installed PE numeric version is $actual, expected $Version" }
    $codes = @(Get-RelatedProducts)
    if ($codes.Count -ne 1 -or $codes[0] -ne $Metadata.ProductCode -or $installer.ProductState($Metadata.ProductCode) -ne 5) {
        throw "Expected one installed product $($Metadata.ProductCode), found $($codes -join ', ')"
    }
    $registeredVersion = ConvertTo-NumericVersion ($installer.ProductInfo($Metadata.ProductCode, 'VersionString'))
    if ($registeredVersion -ne $Version) { throw "Registered MSI version is $registeredVersion, expected $Version" }
    if ($CurrentPayload) {
        if ((Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -ne $expectedHash) {
            throw 'The installed Downpad.exe SHA256 differs from the target build.'
        }
        $asar = Join-Path $folder 'resources\app.asar'
        if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -ne $expectedAsarHash) {
            throw 'The installed resources/app.asar SHA256 differs from the target build.'
        }
    }
    Write-Host "Verified installed product $($Metadata.ProductCode), numeric version $actual, folder $folder"
}

function Start-TestMsi([string]$Arguments, [string]$LogName) {
    # Preserve the environment and a process handle for bounded waits and cleanup.
    $log = Join-Path $diagnostics "$LogName.log"
    Write-TestProgress "Start MSI operation '$LogName'"
    $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList "$Arguments /norestart /L*V! `"$log`"" -PassThru
    [void]$startedProcesses.Add($process)
    [void]$process.Handle
    Write-Host "Started MSI client PID $($process.Id), log $log"
    return $process
}

function Wait-TestProcess([Diagnostics.Process]$Process, [int]$Seconds = $TimeoutSeconds) {
    # Start-Process -Wait also waits for descendants, including the launched app.
    Write-TestProgress "Wait for MSI client PID $($Process.Id), limit $Seconds seconds"
    if (-not $Process.WaitForExit($Seconds * 1000)) { throw "Process $($Process.Id) timed out after $Seconds seconds." }
    if ($Process.ExitCode -ne 0) { throw "MSI client $($Process.Id) failed with exit code $($Process.ExitCode)." }
    Write-TestProgress "MSI client PID $($Process.Id) completed"
}

function Get-TestAppProcesses {
    # The guarded default installation path is owned by this test. Retain process
    # objects to avoid killing unrelated processes if Windows later reuses a PID.
    foreach ($process in @(Get-Process -Name Downpad -ErrorAction SilentlyContinue)) {
        try {
            if ($process.Path -ieq $installedExe -and $process.StartTime -ge $testStarted) {
                if (-not $appProcesses.ContainsKey($process.Id)) {
                    [void]$process.Handle
                    $appProcesses[$process.Id] = $process
                }
                $process
            }
        } catch [System.InvalidOperationException] { }
        catch [System.ComponentModel.Win32Exception] { }
    }
}

function Stop-TestApps([datetime]$Deadline) {
    # Include Electron helpers, but never kill by image name or unrelated path.
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        [void](Get-RemainingMilliseconds $Deadline)
        [void]@(Get-TestAppProcesses)
        foreach ($process in @($appProcesses.Values)) {
            try {
                if (-not $process.HasExited) {
                    Write-TestProgress "Stop test app PID $($process.Id)"
                    [void]$process.CloseMainWindow()
                    if (-not $process.WaitForExit([Math]::Min(3000, (Get-RemainingMilliseconds $Deadline)))) {
                        $process.Kill()
                        [void]$process.WaitForExit([Math]::Min(5000, (Get-RemainingMilliseconds $Deadline)))
                    }
                    if (-not $process.HasExited) { throw 'Process is still running after termination.' }
                }
            } catch { [void]$cleanupFailures.Add("Could not stop test app PID $($process.Id). $_") }
        }
    }
}

function Save-Diagnostics([string]$Label) {
    # Capture before dismissing any error. Screenshot failure must not hide it.
    Write-TestProgress "Capture diagnostics '$Label'"
    $text = New-Object 'System.Collections.Generic.List[string]'
    foreach ($process in $startedProcesses) {
        foreach ($window in [DownpadMsiTest.Native]::Windows($process.Id)) {
            [void]$text.Add("PID $($process.Id) $($window.ClassName) $($window.Text)")
            foreach ($child in [DownpadMsiTest.Native]::Children($window.Handle)) {
                [void]$text.Add("  $($child.ClassName) enabled=$($child.Enabled) $($child.Text)")
            }
        }
    }
    $text | Set-Content -LiteralPath (Join-Path $diagnostics "$Label-windows.txt") -Encoding UTF8
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save((Join-Path $diagnostics "$Label.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    } catch { Write-Warning "Could not capture screenshot. $_" }
    Write-TestProgress "Finished diagnostic capture '$Label'"
}

function Invoke-InstallWizard([Diagnostics.Process]$Process) {
    # WiX's English assisted UI has Welcome, scope, ready, progress, and Exit.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastAction = ''
    $lastActionAt = Get-Date
    $sawWelcome = $false
    $clickedInstall = $false
    $clickedFinish = $false
    $windowSince = $null
    $log = Join-Path $diagnostics 'wizard.log'
    Write-TestProgress "Drive installer wizard PID $($Process.Id)"
    while ((Get-Date) -lt $deadline) {
        Write-TestProgress 'Inspect wizard windows' -Quiet
        $windows = @([DownpadMsiTest.Native]::Windows($Process.Id))
        foreach ($window in $windows) {
            Write-TestProgress "Inspect wizard controls for window $($window.Handle)" -Quiet
            $children = @([DownpadMsiTest.Native]::Children($window.Handle))
            $dialogText = (@($window.Text) + @($children | ForEach-Object { $_.Text })) -join "`n"
            if ($dialogText -match '(?i)\berror\b|\bfailed\b|prematurely|not marked for installation') {
                throw "Installer error dialog after '$lastAction'.`n$dialogText"
            }
            $buttons = @($children | Where-Object { $_.ClassName -eq 'Button' -and $_.Enabled })
            if (@($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -match '^(OK|Yes|No|Retry|Abort|Ignore)$' }).Count -gt 0) {
                throw "Unexpected installer modal dialog.`n$dialogText"
            }
            if ($clickedFinish) { continue }
            $next = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -match '^Next\s*>?$' })
            $install = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Install' })
            $finish = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Finish' })
            $target = $null
            $action = ''
            if ($finish.Count -eq 1) {
                if (-not $sawWelcome -or -not $clickedInstall) { throw "Reached Finish without Welcome and Install.`n$dialogText" }
                $run = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Run Downpad' })
                if ($run.Count -ne 1) { throw "Exit dialog does not offer Run Downpad.`n$dialogText" }
                if ([DownpadMsiTest.Native]::Checked($run[0].Handle) -ne 1) {
                    $target = $run[0]; $action = 'check Run Downpad'
                } else {
                    Save-Diagnostics 'before-finish'
                    $target = $finish[0]; $action = 'Finish with Run Downpad checked'; $clickedFinish = $true
                }
            } elseif ($install.Count -eq 1) {
                $target = $install[0]; $action = 'Install'; $clickedInstall = $true
            } elseif ($next.Count -eq 1) {
                if ($dialogText -match '(?i)welcome') { $sawWelcome = $true }
                $perUser = @($buttons | Where-Object { $_.Text.Replace('&', '') -match '(?i)just for you|only for me|just for me' })
                if ($perUser.Count -eq 1 -and [DownpadMsiTest.Native]::Checked($perUser[0].Handle) -ne 1) {
                    $target = $perUser[0]; $action = 'select per-user installation'
                } else { $target = $next[0]; $action = "Next $($window.Handle) $dialogText" }
            }
            if ($target -and $action -ne $lastAction) {
                Write-Host "Wizard action $($action.Split([char]10)[0])"
                [DownpadMsiTest.Native]::Click($target.Handle)
                $lastAction = $action
                $lastActionAt = Get-Date
            } elseif ($target -and ((Get-Date) - $lastActionAt).TotalSeconds -gt 20) {
                throw "Installer did not respond to '$lastAction'.`n$dialogText"
            }
        }
        Write-TestProgress 'Read wizard log' -Quiet
        if (Test-Path -LiteralPath $log) {
            $errors = @(Select-String -LiteralPath $log -Pattern 'Error 2753', 'not marked for installation', 'Return value 3\.' | Select-Object -Last 8)
            if ($errors.Count -gt 0) { throw "MSI log reports failure.`n$($errors -join "`n")" }
        }
        $hasWindow = $false
        Write-TestProgress 'Inspect installed app processes and windows' -Quiet
        foreach ($app in @(Get-TestAppProcesses)) {
            if (-not $clickedFinish) { throw 'Downpad started before the Finish button was clicked.' }
            if (@([DownpadMsiTest.Native]::Windows($app.Id) | Where-Object { $_.ClassName -eq 'Chrome_WidgetWin_1' }).Count -gt 0) {
                $hasWindow = $true
            }
        }
        if ($hasWindow) {
            if (-not $windowSince) { $windowSince = Get-Date }
        } else { $windowSince = $null }
        Write-TestProgress 'Check wizard client exit' -Quiet
        if ($Process.HasExited) {
            if ($Process.ExitCode -ne 0) { throw "Wizard exited with code $($Process.ExitCode)." }
            if (-not $clickedFinish) { throw 'Wizard exited without clicking Finish with Run Downpad checked.' }
            if ($windowSince -and ((Get-Date) - $windowSince).TotalSeconds -ge 2) {
                # The profile must be used by the custom action's child, not only
                # created by this script. Electron writes Preferences at startup.
                $profileFiles = @(Get-ChildItem -LiteralPath $env:DOWNPAD_USER_DATA_DIR -Force | Where-Object { $_.Name -ne 'settings.toml' })
                if ($profileFiles.Count -eq 0) { throw 'The launched app did not use DOWNPAD_USER_DATA_DIR.' }
                Save-Diagnostics 'launched'
                Write-Host "Finish launched the installed application with a visible window. PIDs $($appProcesses.Keys -join ', ')"
                return
            }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out after $TimeoutSeconds seconds waiting for the wizard and installed application window. Last action '$lastAction'."
}

function Get-RemainingMilliseconds([datetime]$Deadline) {
    # A shared deadline prevents retries and product cleanup from resetting waits.
    $remaining = [Math]::Ceiling(($Deadline - (Get-Date)).TotalMilliseconds)
    if ($remaining -le 0) { throw 'The MSI removal or cleanup time budget expired.' }
    return [int][Math]::Min([int]::MaxValue, $remaining)
}

function Wait-InstallerIdle([datetime]$Deadline) {
    # Killing a UI client does not finish its service transaction. In particular,
    # ProductState can still be unknown before that transaction registers the app.
    $mutex = $null
    $acquired = $false
    Write-TestProgress 'Wait for Windows Installer service transaction to finish'
    try {
        try {
            $rights = [Security.AccessControl.MutexRights]::Synchronize -bor [Security.AccessControl.MutexRights]::Modify
            $mutex = [Threading.Mutex]::OpenExisting('Global\_MSIExecute', $rights)
        } catch [Threading.WaitHandleCannotBeOpenedException] { return }
        try { $acquired = $mutex.WaitOne((Get-RemainingMilliseconds $Deadline)) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Timed out waiting for the Windows Installer service transaction to finish.' }
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
    }
}

function Remove-TestProduct([string]$Code, [string]$Label, [datetime]$Deadline = (Get-Date).AddSeconds($TimeoutSeconds)) {
    # Attempt removal even for an unknown product, after its transaction settles.
    # Retry 1618 if a transaction acquires the installer mutex between these calls.
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        [void](Get-RemainingMilliseconds $Deadline)
        Write-TestProgress "Remove test product $Code, attempt $attempt"
        Wait-InstallerIdle $Deadline
        $process = Start-TestMsi "/x $Code /qn" "$Label-$attempt"
        if (-not $process.WaitForExit((Get-RemainingMilliseconds $Deadline))) { throw "Uninstall timed out for $Code" }
        if ($process.ExitCode -eq 1618 -and $attempt -lt 4) {
            Start-Sleep -Milliseconds ([Math]::Min(3000, (Get-RemainingMilliseconds $Deadline)))
            continue
        }
        if ($process.ExitCode -notin @(0, 1605)) { throw "Uninstall of $Code returned $($process.ExitCode)" }
        return
    }
}

function Assert-Removed {
    # Keep the original silent CI check for removing the updater registration.
    $registration = Get-ItemProperty -LiteralPath 'HKCU:\Software\Downpad' -ErrorAction SilentlyContinue
    if ($registration -and $registration.PSObject.Properties['InstallDir']) { throw 'Uninstall left InstallDir behind.' }
    if (Test-Path -LiteralPath $installedExe) { throw 'Uninstall left Downpad.exe behind.' }
    if (@(Get-RelatedProducts).Count -ne 0) { throw 'Uninstall left a related MSI product registered.' }
}

try {
    Write-TestProgress 'Activate Windows Installer COM'
    $installer = New-Object -ComObject WindowsInstaller.Installer
    Write-TestProgress 'Windows Installer COM activated'
    $current = Get-MsiMetadata $Msi
    if ((ConvertTo-NumericVersion $current.ProductVersion) -ne $ExpectedVersion -or
        (ConvertTo-NumericVersion $current.ExecutableVersion) -ne $ExpectedVersion -or
        (Get-PeVersion $ExpectedExecutable) -ne $ExpectedVersion) {
        throw ("Target versions disagree. Expected $ExpectedVersion, MSI $($current.ProductVersion), File table $($current.ExecutableVersion), PE $(Get-PeVersion $ExpectedExecutable). " +
            'Check that scripts/apply-version-from-tag.mjs sets a numeric build.buildVersion before packaging. Branches that predate the numeric-version fix must include it before retrying.')
    }
    $previous = $null
    if ($PreviousMsi) {
        $previous = Get-MsiMetadata $PreviousMsi
        if ($previous.UpgradeCode -ne $current.UpgradeCode -or $previous.ProductCode -eq $current.ProductCode) {
            throw 'Upgrade fixtures must share an UpgradeCode and have different ProductCodes.'
        }
        $previousVersion = ConvertTo-NumericVersion $previous.ProductVersion
        if ((ConvertTo-NumericVersion $previous.ExecutableVersion) -ne $previousVersion) {
            throw 'The previous MSI must have matching numeric product and executable versions.'
        }
        if ($RecoverMissingExecutable) {
            if ($previousVersion -ne $ExpectedVersion) { throw 'Recovery testing requires equal MSI product versions.' }
        } elseif ([version]$previousVersion -ge [version]$ExpectedVersion) {
            throw 'The previous MSI must precede the current MSI outside recovery testing.'
        }
    }
    foreach ($key in @('HKCU:\Software\Downpad', 'HKCU:\Software\WOW6432Node\Downpad', 'HKLM:\Software\Downpad', 'HKLM:\Software\WOW6432Node\Downpad')) {
        if (Test-Path -LiteralPath $key) { throw "Refusing to touch an existing Downpad registry key at $key" }
    }
    if (@(Get-RelatedProducts).Count -gt 0 -or (Test-Path -LiteralPath $installFolder) -or @(Get-Process -Name Downpad, md-easy -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Refusing to touch an existing Downpad installation, directory, or process. Use a clean Windows test account.'
    }
    $env:DOWNPAD_USER_DATA_DIR = Join-Path $diagnostics 'user-data'
    $env:DOWNPAD_UPDATE_API_URL = 'http://127.0.0.1:1/no-updates'
    [void](New-Item -ItemType Directory -Path $env:DOWNPAD_USER_DATA_DIR)
    [IO.File]::WriteAllText((Join-Path $env:DOWNPAD_USER_DATA_DIR 'settings.toml'), "autoUpdate = false`nhasSeenWelcome = true`nhasCheckedDefaultHandler = true`n", (New-Object Text.UTF8Encoding($false)))
    @{
        scenario = $Scenario; msi = $Msi; previousMsi = $PreviousMsi
        expectedVersion = $ExpectedVersion; expectedExecutable = $ExpectedExecutable
        executableSha256 = $expectedHash; asarSha256 = $expectedAsarHash
        productCode = $current.ProductCode; upgradeCode = $current.UpgradeCode
        recoverMissingExecutable = [bool]$RecoverMissingExecutable
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $diagnostics 'inputs.json') -Encoding UTF8
    if ($previous) {
        [void]$attemptedProducts.Add($previous.ProductCode)
        Wait-TestProcess (Start-TestMsi "/i `"$PreviousMsi`" /qn" 'previous-silent-install')
        Assert-Installed $previous $previousVersion
        if ($RecoverMissingExecutable) {
            # Fault injection is limited to the installation this test created.
            # Reject redirected paths before removing its single executable.
            $item = Get-Item -LiteralPath $installedExe -Force
            while ($item) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to remove an executable through a reparse point at $($item.FullName)" }
                if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
            }
            # electron-builder marks MSI files read-only. Force permits removing
            # this guarded test file without changing installation permissions.
            Remove-Item -LiteralPath $installedExe -Force
            if (Test-Path -LiteralPath $installedExe) { throw 'The recovery fixture still has its executable.' }
            if ($installer.ProductState($previous.ProductCode) -ne 5) { throw 'The damaged recovery fixture lost its MSI registration.' }
            Write-Host 'Removed the test executable. The next RC must restore it through a same-version upgrade.'
        }
    } else {
        [void]$attemptedProducts.Add($current.ProductCode)
        Wait-TestProcess (Start-TestMsi "/i `"$Msi`" /qn" 'current-silent-install')
        Assert-Installed $current $ExpectedVersion -CurrentPayload
        Remove-TestProduct $current.ProductCode 'silent-uninstall'
        Assert-Removed
    }
    if (-not $attemptedProducts.Contains($current.ProductCode)) { [void]$attemptedProducts.Add($current.ProductCode) }
    Invoke-InstallWizard (Start-TestMsi "/i `"$Msi`" /qf" 'wizard')
    Assert-Installed $current $ExpectedVersion -CurrentPayload
    if ($previous -and $installer.ProductState($previous.ProductCode) -ne -1) { throw 'The previous MSI product is still registered after upgrade.' }
} catch {
    $failure = $_
    Write-TestProgress "MSI test failure. $failure"
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $diagnostics 'failure.txt') -Encoding UTF8
    Save-Diagnostics 'failure'
} finally {
    $cleanupDeadline = (Get-Date).AddSeconds(120)
    Write-TestProgress 'Begin cleanup with a shared 120-second wait budget'
    # Stop only clients this script started. Never stop the shared MSI service.
    foreach ($process in $startedProcesses.ToArray()) {
        try {
            if (-not $process.HasExited) {
                Write-TestProgress "Stop MSI client PID $($process.Id)"
                $process.Kill()
                [void]$process.WaitForExit([Math]::Min(5000, (Get-RemainingMilliseconds $cleanupDeadline)))
            }
        } catch { [void]$cleanupFailures.Add("Could not stop MSI client $($process.Id). $_") }
    }
    if ($attemptedProducts.Count -gt 0) {
        try { Stop-TestApps $cleanupDeadline } catch { [void]$cleanupFailures.Add("Could not stop test app processes. $_") }
    }
    for ($index = $attemptedProducts.Count - 1; $index -ge 0; $index--) {
        try { Remove-TestProduct $attemptedProducts[$index] "cleanup-$index" $cleanupDeadline }
        catch { [void]$cleanupFailures.Add("Could not remove test product. $_") }
    }
    # Also retain and stop a cleanup client if its own timeout fired.
    foreach ($process in $startedProcesses) {
        try {
            if (-not $process.HasExited) {
                Write-TestProgress "Stop cleanup MSI client PID $($process.Id)"
                $process.Kill()
                [void]$process.WaitForExit([Math]::Min(5000, (Get-RemainingMilliseconds $cleanupDeadline)))
            }
        }
        catch { [void]$cleanupFailures.Add("Could not stop cleanup MSI client $($process.Id). $_") }
        $process.Dispose()
    }
    # Exhausting the wait budget must not prevent termination of retained apps.
    foreach ($process in $appProcesses.Values) {
        try {
            if (-not $process.HasExited) {
                Write-TestProgress "Stop remaining test app PID $($process.Id)"
                $process.Kill()
                [void]$process.WaitForExit([Math]::Min(5000, (Get-RemainingMilliseconds $cleanupDeadline)))
            }
        } catch { [void]$cleanupFailures.Add("Could not stop remaining test app PID $($process.Id). $_") }
        $process.Dispose()
    }
    if ($attemptedProducts.Count -gt 0) {
        try {
            [void](Get-RemainingMilliseconds $cleanupDeadline)
            Write-TestProgress 'Verify test product removal'
            Assert-Removed
        } catch { [void]$cleanupFailures.Add([string]$_) }
    }
    $env:DOWNPAD_USER_DATA_DIR = $oldDataDir
    $env:DOWNPAD_UPDATE_API_URL = $oldUpdateUrl
    if ($installer) {
        Write-TestProgress 'Release Windows Installer COM'
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
    Write-TestProgress 'Cleanup completed'
}
if ($failure -or $cleanupFailures.Count -gt 0) {
    foreach ($log in Get-ChildItem -LiteralPath $diagnostics -Filter '*.log') {
        Write-Host "Last MSI log lines from $($log.Name)"
        Get-Content -LiteralPath $log.FullName -Tail 60 | Write-Host
    }
    $cleanupFailures | Set-Content -LiteralPath (Join-Path $diagnostics 'cleanup-errors.txt') -Encoding UTF8
    if ($failure) { Write-Host "MSI test failure. $failure" }
    throw "MSI scenario '$Scenario' failed. $failure $($cleanupFailures -join '; '). Diagnostics at $diagnostics"
}
Write-Host "MSI scenario '$Scenario' passed, including Finish launch, payload verification, and uninstall. Diagnostics at $diagnostics"
