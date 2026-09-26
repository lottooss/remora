/**
 * Deterministic risk classifier for Remora approvals (ADR-0007, blueprint §8.7).
 * Pure functions classifying actions into 'normal' or 'high' risk.
 * Unknown tools, destructive commands, writes outside workspace, and permission changes
 * are classified as 'high' risk.
 */
import path from 'node:path'
import { contains } from './paths.ts'

export type ApprovalRisk = 'normal' | 'high'

export interface RiskClassificationContext {
  sessionWorkspaceRoot?: string
  lowRiskTools?: ReadonlySet<string>
  knownTools?: ReadonlySet<string>
  destructivePatterns?: readonly RegExp[]
}

/** Standard safe read-only tools that are always normal risk. */
export const DEFAULT_LOW_RISK_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_files',
  'read_url_content',
  'search_web',
  'grep',
  'glob',
  'find_by_name',
  'fetch_web_page',
  'inspect_code',
  'git_log',
  'git_status',
  'git_diff',
])

/** Known file-writing / editing tools. */
export const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_file_content',
  'edit_file',
  'apply_diff',
  'delete_file',
])

/** Known command-execution tools. */
export const SHELL_COMMAND_TOOLS = new Set([
  'run_command',
  'bash',
  'powershell',
  'cmd',
  'shell',
  'exec',
  'execute_command',
  'terminal',
])

/** Permission or policy mutation tools that are always high risk. */
export const HIGH_RISK_SYSTEM_TOOLS = new Set([
  'devices.rotateApprovalKey',
  'devices.revoke',
  'permission_preset_change',
  'approval_policy_change',
  'remora.configure',
])

/**
 * Destructive command regexes for shell commands (bash & PowerShell).
 */
export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // Recursive deletion: rm -rf, rm -r -f, rm -fr, rmdir /s, Remove-Item -Recurse -Force, del /s
  /\brm\s+.*?(-[a-zA-Z]*r[a-zA-Z0-9-]*\s+.*?-[a-zA-Z]*f\b|-[a-zA-Z]*f[a-zA-Z0-9-]*\s+.*?-[a-zA-Z]*r\b|-[a-zA-Z]*r[a-zA-Z]*f\b|-[a-zA-Z]*f[a-zA-Z]*r\b|--recursive\b.*?--force\b|--force\b.*?--recursive\b)/i,
  /\brmdir\s+.*?\/s\b/i,
  /\b(Remove-Item|ri|del|erase)\b.*?(-Recurse\b|-r\b).*?(-Force\b|-fo\b)/i,
  /\b(Remove-Item|ri|del|erase)\b.*?(-Force\b|-fo\b).*?(-Recurse\b|-r\b)/i,
  /\b(del|erase)\s+.*?\/s\b/i,

  // Git force push, hard reset, git clean -f
  /\bgit\s+push\b.*?(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[a-zA-Z0-9_/-]+)/i,
  /\bgit\s+reset\b.*?\s--hard\b/i,
  /\bgit\s+clean\b.*?(\s-[a-zA-Z]*f)/i,
  /\bgit\s+branch\b.*?(\s-[a-zA-Z]*D\b|\s--delete\s+--force\b)/,

  // Disk / partition formatting / raw writes
  /\bformat\s+[A-Za-z]:/i,
  /\b(fdisk|diskpart|mkfs|mkfs\.[a-z0-9]+)\b/i,
  /\bdd\b.*?\bif=/i,
  /\bvssadmin\s+delete\s+shadows\b/i,

  // Windows registry editing / deletion
  /\breg\s+(add|delete)\b/i,
  /\b(Set-ItemProperty|Remove-ItemProperty|New-ItemProperty)\b.*?\b(HKLM|HKEY_LOCAL_MACHINE)\b/i,

  // Credential harvesting / secret extraction
  /(id_rsa|id_ed25519|\.aws\/credentials|application_default_credentials\.json)\b/i,
  /\b(security\s+dump-keychain|mimikatz|vault\s+operator)\b/i,

  // Download-to-execution pipes: curl/wget | (sh|bash|powershell|pwsh) or iex (iwr ...)
  /\b(curl|wget)\b.*?\|\s*(sh|bash|zsh|dash|powershell|pwsh|cmd)(\s+|$)/i,
  /\b(Invoke-Expression|iex)\b.*?\b(Invoke-WebRequest|iwr|curl|wget)\b/i,
  /\b(irm|Invoke-RestMethod)\b.*?\|\s*(iex|Invoke-Expression)\b/i,

  // Privilege escalation and system shutdown/reboot
  /\b(sudo|doas|runas)\s+/i,
  /\b(shutdown|reboot|init\s+0|init\s+6|Stop-Computer|Restart-Computer)\b/i,

  // Disabling security controls
  /\bSet-MpPreference\b.*?-DisableRealtimeMonitoring\b/i,
  /\b(ufw\s+disable|systemctl\s+stop\s+(firewalld|iptables))\b/i,
]

/**
 * Extracts candidate target file path from tool arguments if present.
 */
function extractTargetFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  const candidate =
    obj.targetFile ??
    obj.TargetFile ??
    obj.path ??
    obj.filePath ??
    obj.file ??
    obj.destination ??
    obj.target
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim()
  }
  return null
}

/**
 * Extracts command line string from tool arguments if present.
 */
function extractCommandLine(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  const candidate =
    obj.CommandLine ??
    obj.commandLine ??
    obj.command ??
    obj.cmd ??
    obj.script
  if (typeof candidate === 'string') {
    return candidate
  }
  return null
}

/**
 * Tokenizes shell command string into pipeline commands, handling quotes and subshells.
 */
export function tokenizeShellCommands(commandLine: string): string[] {
  const commands: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i]!

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      current += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }

    // Command separators: ;, &&, ||, \n outside quotes
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '\n' || char === ';') {
        if (current.trim().length > 0) commands.push(current.trim())
        current = ''
        continue
      }
      if (
        (char === '&' && commandLine[i + 1] === '&') ||
        (char === '|' && commandLine[i + 1] === '|')
      ) {
        if (current.trim().length > 0) commands.push(current.trim())
        current = ''
        i++ // Skip second character
        continue
      }
    }

    current += char
  }

  if (current.trim().length > 0) {
    commands.push(current.trim())
  }

  return commands
}

/**
 * Classifies an approval request into 'normal' or 'high' risk deterministically.
 */
export function classifyRisk(
  toolName: string,
  args: unknown,
  context?: RiskClassificationContext,
): ApprovalRisk {
  const lowRiskTools = context?.lowRiskTools ?? DEFAULT_LOW_RISK_TOOLS
  const destructivePatterns = context?.destructivePatterns ?? DEFAULT_DESTRUCTIVE_PATTERNS

  // 1. High risk system/policy mutation tools
  if (HIGH_RISK_SYSTEM_TOOLS.has(toolName)) {
    return 'high'
  }

  // 2. Check for sandbox escalation or elevation requests in arguments
  if (args && typeof args === 'object') {
    const obj = args as Record<string, unknown>
    if (obj.escalate === true || obj.privileged === true || obj.elevationRequested === true) {
      return 'high'
    }
  }

  // 3. Low risk safe tools
  if (lowRiskTools.has(toolName)) {
    return 'normal'
  }

  // 4. File write tools: check if writing outside session workspace
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const targetPath = extractTargetFilePath(args)
    if (!targetPath) {
      // Cannot determine target file -> high risk
      return 'high'
    }

    // Lexical check for directory traversal escape (e.g. "../")
    const normalized = path.normalize(targetPath)
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      if (!context?.sessionWorkspaceRoot) {
        // Absolute or traversal without workspace root -> high risk
        return 'high'
      }
      // Check containment inside sessionWorkspaceRoot
      if (!contains(context.sessionWorkspaceRoot, targetPath)) {
        return 'high'
      }
    }

    return 'normal'
  }

  // 5. Command execution tools: check for destructive patterns
  if (SHELL_COMMAND_TOOLS.has(toolName)) {
    const cmdLine = extractCommandLine(args)
    if (!cmdLine || cmdLine.trim().length === 0) {
      return 'normal'
    }

    // Check full commandLine and tokenized commands against destructive patterns
    for (const pattern of destructivePatterns) {
      if (pattern.test(cmdLine)) {
        return 'high'
      }
    }

    const subCommands = tokenizeShellCommands(cmdLine)
    for (const subCmd of subCommands) {
      for (const pattern of destructivePatterns) {
        if (pattern.test(subCmd)) {
          return 'high'
        }
      }
    }

    return 'normal'
  }

  // 6. Unknown tools: default to high risk
  return 'high'
}
