import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacAlgorithm = 'sha256' | 'sha512' | 'sha1';

export interface VerifyHmacOptions {
  algorithm?: HmacAlgorithm;
  /** Raw body of the HTTP request — must be the bytes as received. */
  rawBody: Buffer | string;
  /** Signature header value sent by the partner (hex or base64). */
  signature: string;
  /**
   * Current shared secret. Always tried first.
   * If you store secrets per-integration, pass the active one here.
   */
  secret: string;
  /**
   * Optional previous secret for graceful key rotation. When the partner
   * is still signing with the old key during a rotation window, we accept
   * both and the operator can drop the previous secret once traffic stops
   * matching it.
   */
  previousSecret?: string | null;
  /**
   * Optional prefix on the signature value (e.g. "sha256=" from GitHub
   * style headers). Stripped before comparison.
   */
  stripPrefix?: string;
}

export interface VerifyHmacResult {
  valid: boolean;
  /** Which secret matched — 'current', 'previous', or null when valid=false. */
  matchedSecret: 'current' | 'previous' | null;
  /** Why verification failed; useful for structured logs. */
  reason?:
    | 'empty_signature'
    | 'malformed_signature'
    | 'length_mismatch'
    | 'no_match';
}

/**
 * Constant-time HMAC verification.
 *
 * Threat model: an attacker who can observe how long a comparison takes
 * could otherwise learn bytes of the secret one at a time. crypto.timingSafeEqual
 * branches in constant time. We also derive the *expected* signature from the
 * shared secret + raw body, never trusting any client-supplied length.
 *
 * If the signature length doesn't match the expected length (after format
 * normalisation), short-circuit — comparing different-length buffers with
 * timingSafeEqual throws, and the difference itself is not secret.
 */
export function verifyHmacSignature(opts: VerifyHmacOptions): VerifyHmacResult {
  const {
    rawBody,
    signature,
    secret,
    previousSecret,
    algorithm = 'sha256',
  } = opts;

  if (!signature) {
    return { valid: false, matchedSecret: null, reason: 'empty_signature' };
  }

  let normalised = signature.trim();
  if (opts.stripPrefix && normalised.startsWith(opts.stripPrefix)) {
    normalised = normalised.slice(opts.stripPrefix.length);
  }

  const provided = decodeSignature(normalised);
  if (!provided) {
    return { valid: false, matchedSecret: null, reason: 'malformed_signature' };
  }

  if (matches(rawBody, secret, algorithm, provided)) {
    return { valid: true, matchedSecret: 'current' };
  }

  if (previousSecret && matches(rawBody, previousSecret, algorithm, provided)) {
    return { valid: true, matchedSecret: 'previous' };
  }

  return { valid: false, matchedSecret: null, reason: 'no_match' };
}

function matches(
  rawBody: Buffer | string,
  secret: string,
  algorithm: HmacAlgorithm,
  provided: Buffer,
): boolean {
  const expected = createHmac(algorithm, secret).update(rawBody).digest();
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

/**
 * Accept hex or base64 (with/without padding). Returns null on any parse
 * failure so the caller can short-circuit before constant-time comparison.
 */
function decodeSignature(input: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
    try {
      return Buffer.from(input, 'hex');
    } catch {
      return null;
    }
  }

  if (/^[A-Za-z0-9+/=_-]+$/.test(input)) {
    try {
      // Tolerate URL-safe base64 by normalising.
      const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
      const buf = Buffer.from(padded, 'base64');
      // base64 decode silently accepts garbage; sanity-check by re-encoding.
      if (
        buf.toString('base64').replace(/=+$/, '') !==
        normalised.replace(/=+$/, '')
      ) {
        return null;
      }
      return buf;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Compute an HMAC signature for the given payload. Useful in tests and
 * for outgoing webhooks where we are the sender.
 */
export function computeHmacSignature(
  rawBody: Buffer | string,
  secret: string,
  algorithm: HmacAlgorithm = 'sha256',
  encoding: 'hex' | 'base64' = 'hex',
): string {
  return createHmac(algorithm, secret).update(rawBody).digest(encoding);
}
