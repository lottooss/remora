#!/usr/bin/env node
/**
 * P0-S5 spike verifier — Crypto/1 §7 approval signatures from the Android
 * Keystore, checked in Node with @noble/curves (p256).
 *
 * Usage:
 *   node verify.mjs <spki-b64u> <sig-b64u> <message-file> [preview.json]
 *   node verify.mjs --json <phone-export.json>
 *
 * Options passed to p256.verify (Crypto/1 §7): { prehash: true, lowS: false, format: 'der' }.
 *   prehash  — SHA-256 over the message bytes, matching JCA "SHA256withECDSA"
 *   lowS     — false: Android Keystore does not normalize s, so high-S is accepted
 *   format   — DER signature encoding (SEQUENCE of two INTEGERs)
 *
 * Note: Crypto/1 §7 writes the module as `@noble/curves/p256`; in
 * @noble/curves 2.x the p256 curve lives in `@noble/curves/nist.js`.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { p256 } from '@noble/curves/nist.js';

const VERIFY_OPTS = Object.freeze({ prehash: true, lowS: false, format: 'der' });

const SPKI_EC_PUBLIC_KEY_OID = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
const SPKI_PRIME256V1_OID = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readTlv(buf, offset, tag, what) {
  if (offset >= buf.length) throw new Error(`SPKI: truncated ${what}`);
  if (buf[offset] !== tag) throw new Error(`SPKI: expected tag 0x${tag.toString(16)} for ${what}, got 0x${buf[offset].toString(16)}`);
  let pos = offset + 1;
  if (pos >= buf.length) throw new Error(`SPKI: missing length for ${what}`);
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || pos + n > buf.length) throw new Error(`SPKI: bad length for ${what}`);
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
  }
  const end = pos + len;
  if (end > buf.length) throw new Error(`SPKI: value overruns buffer for ${what}`);
  return { value: buf.subarray(pos, end), end };
}

/** Strictly parse a P-256 SubjectPublicKeyInfo DER; return the SEC1 point bytes. */
export function spkiToPoint(spki) {
  if (!(spki instanceof Uint8Array) || spki.length === 0) throw new Error('SPKI: empty');
  const outer = readTlv(spki, 0, 0x30, 'SubjectPublicKeyInfo');
  if (outer.end !== spki.length) throw new Error('SPKI: trailing bytes after SubjectPublicKeyInfo');
  const alg = readTlv(outer.value, 0, 0x30, 'AlgorithmIdentifier');
  const oidKey = readTlv(alg.value, 0, 0x06, 'id-ecPublicKey');
  if (!bytesEqual(oidKey.value, SPKI_EC_PUBLIC_KEY_OID)) throw new Error('SPKI: not id-ecPublicKey');
  const oidCurve = readTlv(alg.value, oidKey.end, 0x06, 'prime256v1');
  if (!bytesEqual(oidCurve.value, SPKI_PRIME256V1_OID)) throw new Error('SPKI: not prime256v1 (P-256)');
  if (oidCurve.end !== alg.value.length) throw new Error('SPKI: unexpected AlgorithmIdentifier parameters');
  const bits = readTlv(outer.value, alg.end, 0x03, 'subjectPublicKey BIT STRING');
  if (bits.end !== outer.value.length) throw new Error('SPKI: trailing bytes after BIT STRING');
  if (bits.value.length < 2 || bits.value[0] !== 0x00) throw new Error('SPKI: BIT STRING must have 0 unused bits');
  const point = bits.value.subarray(1);
  const uncompressed = point.length === 65 && point[0] === 0x04;
  const compressed = point.length === 33 && (point[0] === 0x02 || point[0] === 0x03);
  if (!uncompressed && !compressed) throw new Error(`SPKI: not a P-256 SEC1 point (${point.length} bytes)`);
  return point;
}

/** Wrap SEC1 point bytes into a P-256 SPKI DER (used by the software-key selftest). */
export function pointToSpki(point) {
  if (!(point instanceof Uint8Array)) throw new Error('point must be Uint8Array');
  const uncompressed = point.length === 65 && point[0] === 0x04;
  const compressed = point.length === 33 && (point[0] === 0x02 || point[0] === 0x03);
  if (!uncompressed && !compressed) throw new Error('point must be a P-256 SEC1 point');
  const algId = Uint8Array.of(
    0x30, 0x13,
    0x06, 0x07, ...SPKI_EC_PUBLIC_KEY_OID,
    0x06, 0x08, ...SPKI_PRIME256V1_OID,
  );
  const bitString = new Uint8Array(3 + point.length);
  bitString[0] = 0x03;
  bitString[1] = 1 + point.length;
  bitString[2] = 0x00;
  bitString.set(point, 3);
  const contentLen = algId.length + bitString.length;
  if (contentLen >= 0x80) throw new Error('SPKI too large');
  const spki = new Uint8Array(2 + contentLen);
  spki[0] = 0x30;
  spki[1] = contentLen;
  spki.set(algId, 2);
  spki.set(bitString, 2 + algId.length);
  return spki;
}

export function b64uEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function b64uDecode(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('b64u: empty');
  if (!/^[A-Za-z0-9_-]+=*$/.test(text)) throw new Error('b64u: invalid alphabet');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** SHA-256 hex of UTF-8(previewText) || 0x00 || UTF-8(previewJson) (Crypto/1 §7 argsDigest). */
export function computeArgsDigest(previewText, previewJson) {
  const h = createHash('sha256');
  h.update(Buffer.from(previewText, 'utf8'));
  h.update(Buffer.from([0x00]));
  h.update(Buffer.from(previewJson, 'utf8'));
  return h.digest('hex');
}

/**
 * Parse a canonical approval message (Crypto/1 §7): exactly 10 UTF-8 lines
 * joined by \n with no trailing newline.
 */
export function parseCanonicalApproval(message) {
  if (typeof message !== 'string') throw new Error('message must be a string');
  if (message.endsWith('\n')) throw new Error('canonical: trailing newline');
  const lines = message.split('\n');
  if (lines.length !== 10) throw new Error(`canonical: expected 10 lines, got ${lines.length}`);
  const [header, hostId, deviceId, approvalId, sessionId, callId, toolName, argsDigest, outcome, issuedAt] = lines;
  if (header !== 'remora/1 approval') throw new Error('canonical: bad header');
  for (const [name, v] of Object.entries({ hostId, deviceId, approvalId, sessionId, callId, toolName })) {
    if (v.length === 0 || v.includes('\r')) throw new Error(`canonical: bad ${name}`);
  }
  if (!/^[0-9a-f]{64}$/.test(argsDigest)) throw new Error('canonical: argsDigest must be 64 lowercase hex chars');
  if (outcome !== 'allowed-once' && outcome !== 'rejected') throw new Error('canonical: outcome must be allowed-once|rejected');
  if (!/^\d{1,17}$/.test(issuedAt)) throw new Error('canonical: issuedAt must be decimal ms');
  return { header, hostId, deviceId, approvalId, sessionId, callId, toolName, argsDigest, outcome, issuedAt: Number(issuedAt) };
}

export function messageBytes(message) {
  return new TextEncoder().encode(message);
}

/**
 * Full verification pipeline: b64u decode → strict SPKI parse → canonical
 * parse → ECDSA P-256 verify (DER, high-S accepted). When `preview` is given
 * ({text, json}), the embedded argsDigest is recomputed and compared.
 */
export function verifyApproval({ spki, sig, message, preview }) {
  const report = {
    ok: false,
    signatureValid: false,
    canonical: null,
    canonicalError: null,
    highS: null,
    digestMatch: null,
    messageSha256: null,
    error: null,
  };
  try {
    report.messageSha256 = createHash('sha256').update(Buffer.from(message, 'utf8')).digest('hex');
    let fields = null;
    try {
      fields = parseCanonicalApproval(message);
      report.canonical = fields;
    } catch (e) {
      report.canonicalError = e.message;
    }
    if (preview) {
      if (!fields) {
        report.digestMatch = false;
      } else {
        report.digestMatch = computeArgsDigest(preview.text, preview.json) === fields.argsDigest;
      }
    }
    const point = spkiToPoint(b64uDecode(spki));
    const der = b64uDecode(sig);
    try {
      report.highS = p256.Signature.fromBytes(der, 'der').hasHighS();
    } catch {
      report.highS = null;
    }
    report.signatureValid = p256.verify(der, messageBytes(message), point, VERIFY_OPTS);
    report.ok =
      report.signatureValid &&
      report.canonical !== null &&
      (report.digestMatch === null || report.digestMatch === true);
  } catch (e) {
    report.error = e.message;
  }
  return report;
}

function usage(exitCode) {
  const text = [
    'Usage:',
    '  node verify.mjs <spki-b64u> <sig-b64u> <message-file> [preview.json]',
    '  node verify.mjs --json <phone-export.json>',
    '',
    '  message-file   UTF-8 canonical approval message exactly as signed (no trailing newline)',
    '  preview.json   optional {"text": "...", "json": "..."} to recompute argsDigest',
    '  phone-export   JSON exported by the spike app (v:1, spki, preview?, results[])',
  ].join('\n');
  console.log(text);
  process.exit(exitCode);
}

function printReport(report, index, total) {
  const prefix = total > 0 ? `[${index}/${total}] ` : '';
  if (report.error) {
    console.log(`${prefix}FAIL ${report.error}`);
    return;
  }
  const bits = [
    `signature=${report.signatureValid ? 'valid' : 'INVALID'}`,
    `canonical=${report.canonical ? 'ok' : `bad (${report.canonicalError})`}`,
  ];
  if (report.highS !== null) bits.push(`s=${report.highS ? 'HIGH' : 'low'}`);
  if (report.digestMatch !== null) bits.push(`digest=${report.digestMatch ? 'match' : 'MISMATCH'}`);
  if (report.canonical) {
    bits.push(`approval=${report.canonical.approvalId}`);
    bits.push(`outcome=${report.canonical.outcome}`);
    bits.push(`issuedAt=${report.canonical.issuedAt}`);
  }
  console.log(`${prefix}${report.ok ? 'OK  ' : 'FAIL'} ${bits.join(' · ')}`);
}

function runSingle(argv) {
  const [spki, sig, messagePath, previewPath] = argv;
  const message = readFileSync(messagePath, 'utf8');
  const preview = previewPath ? JSON.parse(readFileSync(previewPath, 'utf8')) : undefined;
  const report = verifyApproval({ spki, sig, message, preview });
  printReport(report, 0, 0);
  process.exit(report.ok ? 0 : 1);
}

function runJson(jsonPath) {
  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (doc.v !== 1 || typeof doc.spki !== 'string' || !Array.isArray(doc.results) || doc.results.length === 0) {
    console.error('export: expected { v: 1, spki, results: non-empty [] }');
    process.exit(1);
  }
  let pass = 0;
  let highS = 0;
  let digestChecks = 0;
  doc.results.forEach((r, i) => {
    const report = verifyApproval({
      spki: doc.spki,
      sig: r.sig,
      message: r.message,
      preview: doc.preview,
    });
    if (report.highS) highS++;
    if (report.digestMatch !== null && report.digestMatch) digestChecks++;
    if (report.ok) pass++;
    printReport(report, i + 1, doc.results.length);
    if (typeof r.promptToSignMs === 'number') {
      console.log(`        latency prompt→sig ${r.promptToSignMs} ms · sign-only ${r.signOnlyMs ?? '?'} ms`);
    }
  });
  const total = doc.results.length;
  console.log('');
  console.log(`summary: ${pass}/${total} verified · high-S ${highS} · low-S ${total - highS} · digest checks ${digestChecks}/${total}`);
  process.exit(pass === total ? 0 : 1);
}

function cliMain(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage(argv.length === 0 ? 1 : 0);
  if (argv[0] === '--json') {
    if (argv.length !== 2) usage(1);
    runJson(argv[1]);
  }
  if (argv.length !== 3 && argv.length !== 4) usage(1);
  runSingle(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain(process.argv.slice(2));
}
