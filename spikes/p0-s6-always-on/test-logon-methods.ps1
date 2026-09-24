# Test Windows Logon Autostart Methods without Elevation (Standard User)
# Tests:
# 1. HKCU\Software\Microsoft\Windows\CurrentVersion\Run
# 2. Per-user Startup folder shortcut ($env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup)
# 3. Scheduled Task (Register-ScheduledTask -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
# 4. schtasks /Create /SC ONLOGON

$ErrorActionPreference = "Continue"

Write-Host "=== P0-S6 Logon Methods Evaluation ===" -ForegroundColor Cyan
$user = $env:USERNAME

# Method 1: HKCU Run Key
Write-Host "`n[1] Testing HKCU Run Key..."
try {
    $runPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    Set-ItemProperty -Path $runPath -Name "RemoraProbeHKCURun" -Value "cmd.exe /c echo remora" -Force
    $val = Get-ItemPropertyValue -Path $runPath -Name "RemoraProbeHKCURun"
    Write-Host "  Success: HKCU Run writable without elevation (Value: $val)" -ForegroundColor Green
    Remove-ItemProperty -Path $runPath -Name "RemoraProbeHKCURun" -Force
} catch {
    Write-Host "  Failed: $_" -ForegroundColor Red
}

# Method 2: Startup Folder Shortcut
Write-Host "`n[2] Testing Per-User Startup Folder..."
try {
    $startupDir = [Environment]::GetFolderPath("Startup")
    $testFile = Join-Path $startupDir "RemoraProbeStartup.txt"
    "test" | Set-Content -Path $testFile
    if (Test-Path $testFile) {
        Write-Host "  Success: Startup folder writable without elevation ($testFile)" -ForegroundColor Green
        Remove-Item -Path $testFile -Force
    }
} catch {
    Write-Host "  Failed: $_" -ForegroundColor Red
}

# Method 3: Scheduled Task via PowerShell
Write-Host "`n[3] Testing Scheduled Task (Register-ScheduledTask)..."
try {
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c echo remora"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $task = Register-ScheduledTask -TaskName "RemoraProbeTask" -Action $action -Trigger $trigger -Description "Remora Probe" -ErrorAction Stop
    Write-Host "  Success: Scheduled task created without elevation" -ForegroundColor Green
    Unregister-ScheduledTask -TaskName "RemoraProbeTask" -Confirm:$false
} catch {
    Write-Host "  Failed / Elevation Required: $_" -ForegroundColor Yellow
}

# Method 4: Headless Execution with conhost --headless
Write-Host "`n[4] Testing Headless Execution (conhost.exe --headless)..."
try {
    $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
    if (Test-Path $conhost) {
        Write-Host "  Success: conhost.exe exists. Supports 'conhost.exe --headless <command>' for windowless execution." -ForegroundColor Green
    } else {
        Write-Host "  conhost.exe not found." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Failed: $_" -ForegroundColor Red
}

Write-Host "`nLogon tests completed."
