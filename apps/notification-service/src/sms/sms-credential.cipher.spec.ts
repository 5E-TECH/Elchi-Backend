import { SmsCredentialCipher } from './sms-credential.cipher';

const A = 'b7e2c9f14a6d03e85f1b2c7a9d4e6f8a0c2b4d6e';
const B = 'c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f2a4b6c8d0';

describe('SmsCredentialCipher', () => {
  it('round-trips and never stores the plain value', () => {
    const cipher = new SmsCredentialCipher(A);
    const enc = cipher.encrypt('eskiz-parol-123');
    expect(enc.startsWith('enc:gcm:')).toBe(true);
    expect(enc).not.toContain('eskiz-parol-123');
    expect(cipher.decrypt(enc)).toBe('eskiz-parol-123');
  });

  it('rejects a plaintext value instead of returning it (fail-closed)', () => {
    expect(() =>
      new SmsCredentialCipher(A).decrypt('plain-password'),
    ).toThrow();
  });

  it('a wrong key fails; the PREVIOUS key works during rotation', () => {
    const old = new SmsCredentialCipher(A).encrypt('login');
    expect(() => new SmsCredentialCipher(B).decrypt(old)).toThrow();
    const rotating = new SmsCredentialCipher(B, A);
    expect(rotating.decrypt(old)).toBe('login');
    expect(rotating.needsReencrypt(old)).toBe(true);
    expect(rotating.needsReencrypt(rotating.encrypt('x'))).toBe(false);
  });

  it('a tampered ciphertext fails authentication', () => {
    const cipher = new SmsCredentialCipher(A);
    const enc = cipher.encrypt('secret');
    const tampered = enc.slice(0, -2) + (enc.endsWith('00') ? '11' : '00');
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('refuses to encrypt without SMS_CREDENTIAL_SECRET', () => {
    expect(() => new SmsCredentialCipher(null).encrypt('x')).toThrow(
      /SMS_CREDENTIAL_SECRET/,
    );
  });
});
