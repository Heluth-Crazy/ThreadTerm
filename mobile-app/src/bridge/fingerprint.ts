/**
 * Certificate fingerprint helpers.
 *
 * Production iOS uses Security framework / URLSessionDelegate to hash the
 * leaf certificate DER and compare against the QR fingerprint before any
 * OTP/token is sent. On web/tests we expose Web Crypto helpers so unit
 * tests can exercise the same comparison rules without Keychain/URLSession.
 *
 * Real Keychain + pinned URLSessionWebSocketTask only exist on macOS/iOS.
 */

import { isValidFingerprint, normalizeFingerprint } from './secureProtocol';

/** Compute lowercase hex SHA-256 of DER bytes (certificate leaf). */
export async function sha256HexOfDer(
  der: ArrayBuffer | Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto?.subtle,
): Promise<string> {
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto is unavailable in this environment.');
  }
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  // Copy into a fresh ArrayBuffer-backed view for TS DOM BufferSource typing.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest('SHA-256', copy);
  return bufferToHex(digest);
}

export function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Compare expected QR fingerprint with presented certificate fingerprint.
 * Both sides are normalized to lowercase hex without colons.
 */
export function fingerprintsMatch(expected: string, presented: string): boolean {
  const a = normalizeFingerprint(expected);
  const b = normalizeFingerprint(presented);
  if (!isValidFingerprint(a) || !isValidFingerprint(b)) return false;
  if (a.length !== b.length) return false;
  // Constant-time-ish compare for tests/JS (native layer should use
  // timing-safe equality on iOS).
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Validate that a presented leaf fingerprint matches the trust anchor from
 * the QR / stored pairing before credentials may be sent.
 */
export function assertFingerprintBeforeCredentials(
  expected: string,
  presented: string,
): void {
  if (!fingerprintsMatch(expected, presented)) {
    throw new FingerprintMismatchError(expected, presented);
  }
}

export class FingerprintMismatchError extends Error {
  readonly code = 'fingerprint_mismatch' as const;
  readonly expected: string;
  readonly presented: string;

  constructor(expected: string, presented: string) {
    super('Desktop certificate fingerprint does not match the paired identity.');
    this.name = 'FingerprintMismatchError';
    this.expected = normalizeFingerprint(expected);
    this.presented = normalizeFingerprint(presented);
  }
}
