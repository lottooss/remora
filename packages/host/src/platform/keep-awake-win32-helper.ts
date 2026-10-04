import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

// One synchronous C# call owns the execution state for its entire lifetime.
// Parent stdin EOF also releases it after an ungraceful Node exit, without a
// PID poll (PID reuse must never let an orphan retain the request).
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Remora {
  public static class KeepAwake {
    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);
    public static void Hold() {
      if (SetThreadExecutionState(0x80000001) == 0)
        throw new InvalidOperationException("Keep-awake acquisition failed");
      try {
        Console.Out.WriteLine("remora-keepawake-ready");
        Console.Out.Flush();
        Console.In.ReadLine();
      } finally {
        SetThreadExecutionState(0x80000000);
      }
    }
  }
}
'@
[Remora.KeepAwake]::Hold()
`

/** Start the Windows fallback. Its stdin pipe owns its lifetime; never detach it. */
export function spawnWindowsKeepAwakeHelper(): ChildProcessWithoutNullStreams {
  const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64'),
  ], { windowsHide: true, detached: false, stdio: 'pipe' })
}
