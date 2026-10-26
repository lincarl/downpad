#requires -Version 5.1
# Chooses each MSI wizard click from a snapshot of the installer's visible
# windows. test-msi.ps1 reads the windows and posts the clicks. These functions
# make no native calls, so msi-wizard.test.mjs can replay dialog sequences.

function New-WizardState([datetime]$Now) {
    # Select-WizardAction updates this state as though each returned click was
    # posted. PendingDialog is the dialog that received Next, Install, or Finish.
    # It stays set until that dialog's handle leaves the snapshot. In recorded CI
    # runs, a reused handle slot got a new high word, so a successor should not
    # repeat the old value. If one did, the driver would wait instead of
    # clicking it and fail after 20 seconds.
    [pscustomobject]@{
        SawWelcome = $false; ClickedInstall = $false; ClickedFinish = $false
        LastAction = ''; LastActionAt = $Now; PendingDialog = $null
    }
}

function Select-WizardAction($State, [object[]]$Windows, [scriptblock]$IsChecked, [datetime]$Now) {
    # Windows hold Handle, Text, and Children with Handle, ClassName, Text, and
    # Enabled. IsChecked reads a radio button or checkbox. Returns the control
    # to click and its action, or $null while the wizard is busy or finished.
    # Throws for installer errors, unexpected modals, and ignored clicks.
    if ($null -ne $State.PendingDialog -and @($Windows | Where-Object { $_.Handle -eq $State.PendingDialog }).Count -eq 0) {
        $State.PendingDialog = $null
    }
    $choice = $null
    foreach ($window in $Windows) {
        $children = @($window.Children)
        $dialogText = (@($window.Text) + @($children | ForEach-Object { $_.Text })) -join "`n"
        if ($dialogText -match '(?i)\berror\b|\bfailed\b|prematurely|not marked for installation') {
            throw "Installer error dialog after '$($State.LastAction)'.`n$dialogText"
        }
        $buttons = @($children | Where-Object { $_.ClassName -eq 'Button' -and $_.Enabled })
        if (@($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -match '^(OK|Yes|No|Retry|Abort|Ignore)$' }).Count -gt 0) {
            throw "Unexpected installer modal dialog.`n$dialogText"
        }
        if ($State.ClickedFinish -or $choice) { continue }
        $waited = ($Now - $State.LastActionAt).TotalSeconds
        if ($null -ne $State.PendingDialog) {
            # Windows Installer replaces the dialog asynchronously and can destroy
            # its controls between a read and a click. The successor can appear
            # before the old dialog closes, so use no window until it has closed.
            if ($window.Handle -eq $State.PendingDialog -and $waited -gt 20) { throw "Installer did not respond to '$($State.LastAction)'.`n$dialogText" }
            continue
        }
        $next = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -match '^Next\s*>?$' })
        $install = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Install' })
        $finish = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Finish' })
        $target = $null
        $action = ''
        $closes = $true
        if ($finish.Count -eq 1) {
            if (-not $State.SawWelcome -or -not $State.ClickedInstall) { throw "Reached Finish without Welcome and Install.`n$dialogText" }
            $run = @($buttons | Where-Object { $_.Text.Replace('&', '').Trim() -eq 'Run Downpad' })
            if ($run.Count -ne 1) { throw "Exit dialog does not offer Run Downpad.`n$dialogText" }
            if ((& $IsChecked $run[0]) -ne 1) {
                $target = $run[0]; $action = 'check Run Downpad'; $closes = $false
            } else {
                $target = $finish[0]; $action = 'Finish with Run Downpad checked'; $State.ClickedFinish = $true
            }
        } elseif ($install.Count -eq 1) {
            $target = $install[0]; $action = 'Install'; $State.ClickedInstall = $true
        } elseif ($next.Count -eq 1) {
            if ($dialogText -match '(?i)welcome') { $State.SawWelcome = $true }
            $perUser = @($buttons | Where-Object { $_.Text.Replace('&', '') -match '(?i)just for you|only for me|just for me' })
            if ($perUser.Count -eq 1 -and (& $IsChecked $perUser[0]) -ne 1) {
                $target = $perUser[0]; $action = 'select per-user installation'; $closes = $false
            } else { $target = $next[0]; $action = "Next on dialog $($window.Handle)" }
        }
        if ($target -and $action -ne $State.LastAction) {
            $choice = [pscustomobject]@{ Target = $target; Action = $action; Dialog = $window.Handle; Closes = $closes }
        } elseif ($target -and $waited -gt 20) {
            throw "Installer did not respond to '$($State.LastAction)'.`n$dialogText"
        }
    }
    if ($choice) {
        $State.LastAction = $choice.Action
        $State.LastActionAt = $Now
        if ($choice.Closes) { $State.PendingDialog = $choice.Dialog }
    }
    return $choice
}
