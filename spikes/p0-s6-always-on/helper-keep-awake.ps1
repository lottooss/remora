# Helper process keep-awake using PowerShell and P/Invoke to SetThreadExecutionState
# Does not require koffi or native node modules.

param (
    [int]$DurationSeconds = 5
)

$signature = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern int SetThreadExecutionState(int esFlags);
'@

if (-not ([System.Management.Automation.PSTypeName]'RemoraHelper.Win32SleepUtilInt').Type) {
    Add-Type -MemberDefinition $signature -Name "Win32SleepUtilInt" -Namespace "RemoraHelper"
}

# 0x80000000 in signed 32-bit int is -2147483648
$ES_SYSTEM_REQUIRED = 0x00000001
$ES_CONTINUOUS = -2147483648

Write-Host "Helper process: Setting ES_CONTINUOUS | ES_SYSTEM_REQUIRED..."
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
$prev = [RemoraHelper.Win32SleepUtilInt]::SetThreadExecutionState($flags)
Write-Host "Helper process: Previous execution state was: 0x$($prev.ToString('X'))"

Write-Host "Helper process: Holding keep-awake for $DurationSeconds seconds..."
Start-Sleep -Seconds $DurationSeconds

Write-Host "Helper process: Releasing keep-awake (ES_CONTINUOUS)..."
[RemoraHelper.Win32SleepUtilInt]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
Write-Host "Helper process: Released."
