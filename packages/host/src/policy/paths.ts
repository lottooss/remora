/**
 * Path canonicalization and containment for the Remora Policy Guard (ADR-0007, blueprint §8.7).
 * Strictly confines remote operations to configured roots and prevents path-traversal escapes
 * (junctions, symlinks, 8.3 short names, UNC paths, device namespaces, NUL injections, ADS).
 */
import fs from 'node:fs'
import path from 'node:path'

/** Windows reserved MS-DOS device names. */
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/** Check for control characters (including NUL) and Windows illegal chars. */
function hasControlOrIllegalChars(rawPath: string): boolean {
  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
    const ch = rawPath[i]
    if (ch === '"' || ch === '<' || ch === '>' || ch === '|' || ch === '?' || ch === '*') return true
  }
  return false
}

/** Windows long-path prefix added by realpathSync.native. */
const LONG_PATH_PREFIX_REGEX = /^\\\\\?\\([A-Za-z]:\\.*)$/

export class PathCanonicalizationError extends Error {
  constructor(message: string, readonly pathValue: string) {
    super(`Path canonicalization denied for "${pathValue}": ${message}`)
    this.name = 'PathCanonicalizationError'
  }
}

/**
 * Validates untrusted path string against malformed and dangerous patterns.
 * Throws PathCanonicalizationError on any violation.
 */
export function validatePathSyntax(rawPath: string): void {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new PathCanonicalizationError('Path must be a non-empty string', String(rawPath))
  }

  // 1. Reject NUL and control characters
  if (hasControlOrIllegalChars(rawPath)) {
    throw new PathCanonicalizationError('Path contains NUL, control characters, or illegal wildcards', rawPath)
  }

  // 2. Reject UNC paths (\\server\share, //server/share)
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    throw new PathCanonicalizationError('UNC network paths are rejected', rawPath)
  }

  // 3. Reject Device namespaces (\\.\, //./, \??\, \Device\, \DosDevices\)
  if (
    rawPath.startsWith('\\\\.\\') ||
    rawPath.startsWith('//./') ||
    rawPath.startsWith('\\??\\') ||
    rawPath.startsWith('/??/') ||
    rawPath.toLowerCase().startsWith('\\device\\') ||
    rawPath.toLowerCase().startsWith('\\dosdevices\\')
  ) {
    throw new PathCanonicalizationError('Device namespaces and NT paths are rejected', rawPath)
  }

  // 4. Check for alternate data streams (ADS) on Windows (e.g. file.txt:stream)
  // Drive letter colon (e.g. C:\) at index 1 is allowed on Windows.
  const isWin = process.platform === 'win32'
  if (isWin) {
    const colonIdx = rawPath.indexOf(':', 2)
    if (colonIdx !== -1) {
      throw new PathCanonicalizationError('Alternate Data Streams (colons) are rejected', rawPath)
    }
  } else if (rawPath.includes(':')) {
    throw new PathCanonicalizationError('Colons in paths are rejected', rawPath)
  }

  // 5. Check segments for DOS devices and trailing dots/spaces on Windows
  const normalizedSeparators = rawPath.replace(/\\/g, '/')
  const segments = normalizedSeparators.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') continue

    // Reject trailing dot or space on Windows (silently stripped by Windows filesystem APIs)
    if (isWin && (seg.endsWith('.') || seg.endsWith(' '))) {
      throw new PathCanonicalizationError('Path segments ending in dot or space are rejected', rawPath)
    }

    // Reject DOS device names (e.g. NUL, CON.txt, com1)
    if (isWin && DOS_DEVICE_REGEX.test(seg)) {
      throw new PathCanonicalizationError(`DOS device name "${seg}" is rejected`, rawPath)
    }
  }
}

/**
 * Canonicalizes a file or directory path by resolving all symlinks, junctions,
 * 8.3 short names, and lexical traversal segments.
 *
 * @throws PathCanonicalizationError if the path is invalid or cannot be resolved.
 */
export function canonicalize(rawPath: string): string {
  validatePathSyntax(rawPath)

  const resolved = path.resolve(rawPath)

  let real: string
  try {
    real = fs.realpathSync.native(resolved)
  } catch (err) {
    throw new PathCanonicalizationError(
      `Cannot resolve realpath (${err instanceof Error ? err.message : String(err)})`,
      rawPath,
    )
  }

  // Normalize Windows long-path prefix (\\?\C:\... -> C:\...)
  if (process.platform === 'win32') {
    const match = LONG_PATH_PREFIX_REGEX.exec(real)
    if (match && match[1]) {
      real = match[1]
    }
    // Capitalize drive letter (c:\ -> C:\)
    if (real.length >= 2 && real[1] === ':') {
      real = real[0]!.toUpperCase() + real.slice(1)
    }
  }

  return path.normalize(real)
}

/**
 * Checks whether candidatePath is strictly contained within root.
 * Both paths are canonicalized (resolving junctions and symlinks).
 *
 * Returns true iff canonical(candidatePath) equals canonical(root) or is a child of canonical(root).
 */
export function contains(root: string, candidatePath: string): boolean {
  try {
    const canonicalRoot = canonicalize(root)
    const canonicalCandidate = canonicalize(candidatePath)

    if (process.platform === 'win32') {
      const r = canonicalRoot.toLowerCase()
      const c = canonicalCandidate.toLowerCase()
      if (c === r) return true
      const prefix = r.endsWith(path.sep) ? r : r + path.sep
      return c.startsWith(prefix)
    }

    if (canonicalCandidate === canonicalRoot) return true
    const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep
    return canonicalCandidate.startsWith(prefix)
  } catch {
    // Fail-closed on any canonicalization error
    return false
  }
}

/**
 * Resolves a list of roots at startup, discarding any invalid or non-existent roots.
 */
export function resolveRoots(roots: readonly string[]): string[] {
  const canonicalRoots: string[] = []
  for (const root of roots) {
    try {
      canonicalRoots.push(canonicalize(root))
    } catch {
      // Discard invalid root
    }
  }
  return canonicalRoots
}
