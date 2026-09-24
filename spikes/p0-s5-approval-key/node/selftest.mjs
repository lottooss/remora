#!/usr/bin/env node
/**
 * P0-S5 selftest — proves the verifier end to end without a phone:
 *  - argsDigest vectors match Crypto/1 §7
 *  - canonical message parsing (positive + negative)
 *  - ≥ 20 signatures verified, including natural high-S and a forced high-S
 *  - tampering / wrong-key negatives fail
 *  - a second signer implementation (WebCrypto, P1363 → DER) verifies
 *  - the verify.mjs CLI works (exit codes)
 *
 * Run: node selftest.mjs   (or: pnpm selftest)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import {
  verifyApproval,
  parseCanonicalApproval,
  computeArgsDigest,
  pointToSpki,
  spkiToPoint,
  b64uEncode,
} from './verify.mjs';

const enc = (s) => new TextEncoder().encode(s);
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function expectThrow(fn) {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
}

const PREVIEW_TEXT = 'Run command: git push --force origin main';
const PREVIEW_JSON = '{"command":"git push --force origin main","cwd":"/home/owner/repo"}';
const PREVIEW_TEXT_UTF8 = 'Mul: \u00b5=\u00a9 \u0434\u0430\u043d\u043d\u044b\u0435';
const PREVIEW_JSON_UTF8 = '{"note":"\u00b5\u00a9 \u0434\u0430\u043d\u043d\u044b"}';

function buildMessage({ approvalId, argsDigest, outcome = 'allowed-once', issuedAt = 1790000000000, callId = 'call-1' }) {
  return [
    'remora/1 approval',
    'h_spike',
    'd_spike',
    approvalId,
    's-0001',
    callId,
    'bash',
    argsDigest,
    outcome,
    String(issuedAt),
  ].join('\n');
}

section('argsDigest vectors (Crypto/1 §7)');
check('ascii vector', computeArgsDigest(PREVIEW_TEXT, PREVIEW_JSON) === '2189f6b6d6012ba8c87f8e74d79e9588d0ce29cbf50d8e32956983fad4131a40');
check('utf-8 vector', computeArgsDigest(PREVIEW_TEXT_UTF8, PREVIEW_JSON_UTF8) === 'c2794f083c5121b981e0b2ac9768d9f31fcbd366575f0370f1d66ddc91d3ba6e');
check('empty vector', computeArgsDigest('', '') === '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');

section('canonical message parsing');
const ARGS_DIGEST = computeArgsDigest(PREVIEW_TEXT, PREVIEW_JSON);
const msg = buildMessage({ approvalId: 'appr-1', argsDigest: ARGS_DIGEST });
const fields = parseCanonicalApproval(msg);
check('parses 10-line message', fields !== null && fields.approvalId === 'appr-1' && fields.outcome === 'allowed-once');
check('issuedAt round-trips', fields.issuedAt === 1790000000000);
check('trailing newline rejected', expectThrow(() => parseCanonicalApproval(msg + '\n')).includes('trailing newline'));
check('wrong line count rejected', expectThrow(() => parseCanonicalApproval(msg.split('\n').slice(0, 9).join('\n'))).includes('10 lines'));
check('bad header rejected', expectThrow(() => parseCanonicalApproval(msg.replace('remora/1 approval', 'remora/1 approvalX'))).includes('header'));
check('bad outcome rejected', expectThrow(() => parseCanonicalApproval(msg.replace('allowed-once', 'approve'))).includes('outcome'));

section('SPKI round-trip and strict parsing');
const key = p256.keygen();
const spki = pointToSpki(key.publicKey);
check('point → SPKI → point', Buffer.from(spkiToPoint(spki)).equals(Buffer.from(key.publicKey)));
check('malformed SPKI rejected', expectThrow(() => spkiToPoint(new Uint8Array([0x30, 0x00]))).length > 0);
const wrongCurve = Uint8Array.from(spki);
// last byte of the prime256v1 OID (…03 01 07 at indices 20..22) → 07 becomes 06
wrongCurve[22] ^= 0x01;
check('non-P-256 curve rejected', expectThrow(() => spkiToPoint(wrongCurve)).includes('prime256v1'));

section('batch verification: 25 signatures (natural high-S expected) + forced high-S');
const sigs = [];
let naturalHighS = 0;
for (let i = 0; i < 25; i++) {
  const m = buildMessage({ approvalId: `appr-${String(i + 1).padStart(4, '0')}`, argsDigest: ARGS_DIGEST, issuedAt: 1790000000000 + i });
  const der = p256.sign(enc(m), key.secretKey, { prehash: true, lowS: false, format: 'der' });
  const highS = p256.Signature.fromBytes(der, 'der').hasHighS();
  if (highS) naturalHighS++;
  const report = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(der), message: m, preview: { text: PREVIEW_TEXT, json: PREVIEW_JSON } });
  sigs.push({ m, der, report, highS });
}
check('25/25 verify with digest match', sigs.every((s) => s.report.ok && s.report.signatureValid && s.report.digestMatch === true));
check('natural high-S produced (≥1)', naturalHighS >= 1, `got ${naturalHighS}`);
console.log(`      natural high-S count: ${naturalHighS}/25`);

const lowSig = sigs.find((s) => !s.highS);
const forcedDer = forceHighS(lowSig.der);
const forcedHighS = p256.Signature.fromBytes(forcedDer, 'der').hasHighS();
const forcedReport = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(forcedDer), message: lowSig.m, preview: { text: PREVIEW_TEXT, json: PREVIEW_JSON } });
check('forced high-S parses as high-S', forcedHighS === true);
check('forced high-S verifies (lowS:false)', forcedReport.ok === true && forcedReport.highS === true);
check('same forced high-S rejected with lowS:true', p256.verify(forcedDer, enc(lowSig.m), key.publicKey, { prehash: true, lowS: true, format: 'der' }) === false);

section('negative cases');
const tamperedMsg = lowSig.m.replace('bash', 'bashh');
const r1 = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(lowSig.der), message: tamperedMsg });
check('tampered message rejected', r1.signatureValid === false && r1.ok === false);

const tamperedDer = Uint8Array.from(lowSig.der);
tamperedDer[Math.floor(tamperedDer.length / 2)] ^= 0x01;
const r2 = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(tamperedDer), message: lowSig.m });
check('tampered signature rejected', r2.signatureValid === false && r2.ok === false);

const otherKey = p256.keygen();
const r3 = verifyApproval({ spki: b64uEncode(pointToSpki(otherKey.publicKey)), sig: b64uEncode(lowSig.der), message: lowSig.m });
check('wrong public key rejected', r3.signatureValid === false && r3.ok === false);

const badDigestMsg = lowSig.m.replace(ARGS_DIGEST, ARGS_DIGEST.slice(0, 63) + (ARGS_DIGEST.endsWith('0') ? '1' : '0'));
const r4 = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(lowSig.der), message: badDigestMsg, preview: { text: PREVIEW_TEXT, json: PREVIEW_JSON } });
check('digest line mismatch reported', r4.digestMatch === false);
check('changed bytes invalidate the signature', r4.signatureValid === false);

const r5 = verifyApproval({ spki: b64uEncode(spki), sig: b64uEncode(lowSig.der), message: lowSig.m + '\n' });
check('non-canonical message → ok=false', r5.ok === false && r5.canonicalError !== null);

section('second signer: WebCrypto (SHA256withECDSA, P1363 → DER)');
const wcKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const wcSpki = new Uint8Array(await webcrypto.subtle.exportKey('spki', wcKeys.publicKey));
const wcMsg = buildMessage({ approvalId: 'appr-wc', argsDigest: ARGS_DIGEST });
const p1363 = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, wcKeys.privateKey, enc(wcMsg)));
const wcDer = p1363ToDer(p1363);
const r6 = verifyApproval({ spki: b64uEncode(wcSpki), sig: b64uEncode(wcDer), message: wcMsg, preview: { text: PREVIEW_TEXT, json: PREVIEW_JSON } });
check('WebCrypto signature verifies via SPKI + DER', r6.ok === true && r6.signatureValid === true, String(r6.error ?? r6.canonicalError ?? ''));

section('CLI end-to-end (verify.mjs exit codes)');
const dir = mkdtempSync(join(tmpdir(), 'p0s5-'));
try {
  const cliSpki = b64uEncode(spki);
  const goodSig = b64uEncode(sigs[0].der);
  writeFileSync(join(dir, 'message.txt'), sigs[0].m, 'utf8');
  writeFileSync(join(dir, 'preview.json'), JSON.stringify({ text: PREVIEW_TEXT, json: PREVIEW_JSON }), 'utf8');
  check('CLI single mode exits 0 on valid signature', cliRuns(0, ['verify.mjs', cliSpki, goodSig, join(dir, 'message.txt'), join(dir, 'preview.json')]));

  writeFileSync(join(dir, 'bad-message.txt'), sigs[0].m.replace('bash', 'bashh'), 'utf8');
  check('CLI single mode exits 1 on tampered message', cliRuns(1, ['verify.mjs', cliSpki, goodSig, join(dir, 'bad-message.txt')]));

  const exportDoc = {
    v: 1,
    spki: cliSpki,
    preview: { text: PREVIEW_TEXT, json: PREVIEW_JSON },
    results: [
      { approvalId: 'appr-1', message: sigs[0].m, sig: goodSig, issuedAt: 1790000000000, promptToSignMs: 420, signOnlyMs: 3 },
      { approvalId: 'appr-2', message: sigs[1].m, sig: b64uEncode(sigs[1].der), issuedAt: 1790000000001, promptToSignMs: 380, signOnlyMs: 2 },
      { approvalId: 'appr-hs', message: lowSig.m, sig: b64uEncode(forcedDer), issuedAt: 1790000000002, promptToSignMs: 350, signOnlyMs: 2 },
    ],
  };
  writeFileSync(join(dir, 'export.json'), JSON.stringify(exportDoc), 'utf8');
  check('CLI --json batch exits 0 (incl. forced high-S)', cliRuns(0, ['verify.mjs', '--json', join(dir, 'export.json')]));

  exportDoc.results[1].message = exportDoc.results[1].message.replace('bash', 'bashh');
  writeFileSync(join(dir, 'export-bad.json'), JSON.stringify(exportDoc), 'utf8');
  check('CLI --json exits 1 when one entry is tampered', cliRuns(1, ['verify.mjs', '--json', join(dir, 'export-bad.json')]));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

function cliRuns(expectedCode, args) {
  const opts = { cwd: import.meta.dirname, stdio: 'pipe' };
  try {
    execFileSync(process.execPath, args, opts);
    return expectedCode === 0;
  } catch (e) {
    return expectedCode !== 0 && e.status === expectedCode;
  }
}

function forceHighS(der) {
  const sig = p256.Signature.fromBytes(der, 'der');
  const n = p256.Point.CURVE().n;
  const high = new p256.Signature(sig.r, n - sig.s);
  if (!high.hasHighS()) throw new Error('forceHighS: result is not high-S');
  return high.toBytes('der');
}

function p1363ToDer(p) {
  if (p.length !== 64) throw new Error('P1363 must be 64 bytes');
  const a = derInt(p.subarray(0, 32));
  const b = derInt(p.subarray(32));
  const body = new Uint8Array(a.length + b.length);
  body.set(a, 0);
  body.set(b, a.length);
  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30;
  out[1] = body.length;
  out.set(body, 2);
  return out;
}

function derInt(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let v = bytes.subarray(start);
  if (v[0] & 0x80) {
    const withZero = new Uint8Array(v.length + 1);
    withZero.set(v, 1);
    v = withZero;
  }
  const out = new Uint8Array(2 + v.length);
  out[0] = 0x02;
  out[1] = v.length;
  out.set(v, 2);
  return out;
}
