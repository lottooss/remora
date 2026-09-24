# P0-S6 Cleanup Script
# Removes any test tasks, registry entries, or leftover probe processes.

$ErrorActionPreference = "SilentlyContinue"

Write-Host "Running P0-S6 residue cleanup..."

# 1. Remove HKCU Run probe
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "RemoraProbeHKCURun" -Force

# 2. Remove Startup file probe
$startupDir = [Environment]::GetFolderPath("Startup")
$testFile = Join-Path $startupDir "RemoraProbeStartup.txt"
if (Test-Path $testFile) {
    Remove-Item -Path $testFile -Force
}

# 3. Remove Scheduled Task probe
Unregister-ScheduledTask -TaskName "RemoraProbeTask" -Confirm:$false

Write-Host "Cleanup completed: 0 residue left." -ForegroundColor Green
