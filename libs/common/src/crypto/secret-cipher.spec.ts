import {
  SECRET_CIPHER_PREFIX,
  SecretCipher,
  SecretCipherError,
  aiProviderKeyAad,
  loadAiKeyMasterSecrets,
} from './secret-cipher';

/** be-brief §5.1 / §12 secret-cipher.spec. Hamma qiymat soxta. */
const MASTER = 'm'.repeat(48);
const MASTER2 = 'n'.repeat(48);
const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40);
const AAD = aiProviderKeyAad('staging', '0b1c2d3e-0000-4000-8000-000000000001');

function errText(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return `${(e as Error).name} ${(e as Error).message} ${String((e as Error).stack)}`;
  }
  throw new Error('kutilgan xato chiqmadi');
}

describe('SecretCipher (be-brief §5.1)', () => {
  const cipher = new SecretCipher({ primary: MASTER });

  it('round trip; format enc:gcm:v1:<iv>:<tag>:<ct>; har safar boshqa iv', () => {
    const a = cipher.encrypt(FAKE_KEY, AAD);
    const b = cipher.encrypt(FAKE_KEY, AAD);
    expect(a.startsWith(SECRET_CIPHER_PREFIX)).toBe(true);
    expect(a).toMatch(/^enc:gcm:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(FAKE_KEY);
    expect(cipher.decrypt(a, AAD)).toBe(FAKE_KEY);
  });

  it('buzilgan shifrmatn — decrypt_failed (fail-closed)', () => {
    const enc = cipher.encrypt(FAKE_KEY, AAD);
    const last = enc.at(-1) === '0' ? '1' : '0';
    const tampered = enc.slice(0, -1) + last;
    expect(() => cipher.decrypt(tampered, AAD)).toThrow(SecretCipherError);
  });

  it('boshqa AAD: boshqa qator id va boshqa APP_ENV — ochilmaydi', () => {
    const enc = cipher.encrypt(FAKE_KEY, AAD);
    expect(() =>
      cipher.decrypt(
        enc,
        aiProviderKeyAad('staging', '0b1c2d3e-0000-4000-8000-000000000002'),
      ),
    ).toThrow(/ochib/);
    expect(() =>
      cipher.decrypt(
        enc,
        aiProviderKeyAad('production', '0b1c2d3e-0000-4000-8000-000000000001'),
      ),
    ).toThrow(/ochib/);
  });

  it('oldingi master bilan shifrlangan qiymat ochiladi va needsReencrypt=true', () => {
    const old = new SecretCipher({ primary: MASTER2 }).encrypt(FAKE_KEY, AAD);
    const rotating = new SecretCipher({ primary: MASTER, previous: MASTER2 });
    expect(rotating.rotating).toBe(true);
    expect(rotating.decrypt(old, AAD)).toBe(FAKE_KEY);
    expect(rotating.needsReencrypt(old, AAD)).toBe(true);
    const fresh = rotating.encrypt(FAKE_KEY, AAD);
    expect(rotating.needsReencrypt(fresh, AAD)).toBe(false);
    // Hech biri bilan ochilmaydi — rotatsiya emas, "unreadable".
    expect(rotating.needsReencrypt('enc:gcm:v1:zz', AAD)).toBe(false);
    // previous yo'q — doim false.
    expect(cipher.needsReencrypt(old, AAD)).toBe(false);
    expect(() => cipher.decrypt(old, AAD)).toThrow(SecretCipherError);
  });

  it('format xatolari: prefiks, qismlar, iv/tag uzunligi', () => {
    for (const bad of [
      '',
      'enc:gcm:aa:bb:cc',
      'enc:gcm:v1:aa:bb',
      'enc:gcm:v1:' + 'a'.repeat(24) + ':' + 'b'.repeat(30) + ':cc',
      'enc:gcm:v1:xyz:' + 'b'.repeat(32) + ':cc',
    ]) {
      expect(() => cipher.decrypt(bad, AAD)).toThrow(SecretCipherError);
    }
  });

  it('sozlanmagan: configured=false, encrypt/decrypt not_configured', () => {
    const none = new SecretCipher({ primary: null });
    expect(none.configured).toBe(false);
    expect(() => none.encrypt('x', AAD)).toThrow(/sozlanmagan/);
    expect(() => none.decrypt('x', AAD)).toThrow(/sozlanmagan/);
  });

  it('qisqa master sir — bad_secret, matnda sir yo‘q', () => {
    const short = 'short-secret-value';
    const text = errText(() => new SecretCipher({ primary: short }));
    expect(text).toMatch(/qisqa/);
    expect(text).not.toContain(short);
  });

  it('xato matnlarida ochiq matn, sir va shifrmatn yo‘q', () => {
    const enc = cipher.encrypt(FAKE_KEY, AAD);
    const texts = [
      errText(() => cipher.decrypt(enc, 'other')),
      errText(() => new SecretCipher({ primary: MASTER2 }).decrypt(enc, AAD)),
      errText(() => cipher.decrypt(enc.replace('v1', 'v9'), AAD)),
    ];
    for (const t of texts) {
      expect(t).not.toContain(FAKE_KEY);
      expect(t).not.toContain(MASTER);
      expect(t).not.toContain(enc.split(':').at(-1));
    }
  });

  it('HKDF info bo‘yicha alohida kalit', () => {
    const other = new SecretCipher({ primary: MASTER, info: 'elchi/other/v1' });
    const enc = cipher.encrypt(FAKE_KEY, AAD);
    expect(() => other.decrypt(enc, AAD)).toThrow(SecretCipherError);
  });
});

describe('loadAiKeyMasterSecrets', () => {
  const files: Record<string, string> = {
    '/run/secrets/ai_key_master': `${MASTER}\n`,
    '/run/secrets/ai_key_master_prev': MASTER2,
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };

  it('fayldan (trim), previous ham', () => {
    expect(
      loadAiKeyMasterSecrets(
        {
          AI_KEY_ENCRYPTION_SECRET_FILE: '/run/secrets/ai_key_master',
          AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE:
            '/run/secrets/ai_key_master_prev',
          APP_ENV: 'production',
        },
        read,
      ),
    ).toEqual({ primary: MASTER, previous: MASTER2, source: 'file' });
  });

  it('oddiy env faqat development’da', () => {
    const env = { AI_KEY_ENCRYPTION_SECRET: MASTER };
    expect(
      loadAiKeyMasterSecrets({ ...env, APP_ENV: 'production' }, read),
    ).toEqual({ primary: null, previous: null, source: 'none' });
    expect(
      loadAiKeyMasterSecrets({ ...env, APP_ENV: 'staging' }, read).source,
    ).toBe('none');
    expect(
      loadAiKeyMasterSecrets({ ...env, APP_ENV: 'development' }, read),
    ).toEqual({ primary: MASTER, previous: null, source: 'env' });
  });

  it('fayl o‘qilmasa — xato, matnda faqat env nomi (yo‘l emas)', () => {
    const text = errText(() =>
      loadAiKeyMasterSecrets(
        { AI_KEY_ENCRYPTION_SECRET_FILE: '/nope/secret-path' },
        read,
      ),
    );
    expect(text).toContain('AI_KEY_ENCRYPTION_SECRET_FILE');
    expect(text).not.toContain('/nope/secret-path');
  });
});
