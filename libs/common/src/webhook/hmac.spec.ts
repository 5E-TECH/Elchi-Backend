import { createHmac } from 'node:crypto';
import { computeHmacSignature, verifyHmacSignature } from './hmac';

const SECRET = 'super-secret-shared-key';
const BODY = '{"order_id":"123","status":"sold"}';

describe('verifyHmacSignature', () => {
  it('accepts a valid hex signature', () => {
    const sig = computeHmacSignature(BODY, SECRET);
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: sig,
      secret: SECRET,
    });
    expect(r.valid).toBe(true);
    expect(r.matchedSecret).toBe('current');
  });

  it('accepts a valid base64 signature', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('base64');
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: sig,
      secret: SECRET,
    });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = computeHmacSignature(BODY, SECRET);
    const r = verifyHmacSignature({
      rawBody: BODY.replace('123', '456'),
      signature: sig,
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_match');
  });

  it('rejects a wrong secret', () => {
    const sig = computeHmacSignature(BODY, SECRET);
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: sig,
      secret: 'different-secret',
    });
    expect(r.valid).toBe(false);
  });

  it('falls back to previousSecret during key rotation', () => {
    const sig = computeHmacSignature(BODY, 'old-secret');
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: sig,
      secret: 'new-secret',
      previousSecret: 'old-secret',
    });
    expect(r.valid).toBe(true);
    expect(r.matchedSecret).toBe('previous');
  });

  it('strips the configured prefix (GitHub-style "sha256=...")', () => {
    const sig = computeHmacSignature(BODY, SECRET);
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: `sha256=${sig}`,
      secret: SECRET,
      stripPrefix: 'sha256=',
    });
    expect(r.valid).toBe(true);
  });

  it('rejects an empty signature header', () => {
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: '',
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('empty_signature');
  });

  it('rejects malformed signature characters', () => {
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: '!!!not-base64-or-hex!!!',
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed_signature');
  });

  it('rejects a signature of wrong length without throwing', () => {
    // A valid-looking hex string but too short → should be rejected via
    // length comparison, not throw from timingSafeEqual.
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: 'aabbccdd',
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_match');
  });

  it('supports sha512', () => {
    const sig = createHmac('sha512', SECRET).update(BODY).digest('hex');
    const r = verifyHmacSignature({
      rawBody: BODY,
      signature: sig,
      secret: SECRET,
      algorithm: 'sha512',
    });
    expect(r.valid).toBe(true);
  });

  it('verifies Buffer raw bodies (post-rawBody middleware)', () => {
    const buf = Buffer.from(BODY, 'utf-8');
    const sig = computeHmacSignature(buf, SECRET);
    const r = verifyHmacSignature({
      rawBody: buf,
      signature: sig,
      secret: SECRET,
    });
    expect(r.valid).toBe(true);
  });
});
