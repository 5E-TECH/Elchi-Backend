import { createHash } from 'crypto';
import {
  TELEGRAM_TOKEN_ENC_PREFIX,
  TelegramTokenCipher,
  TelegramTokenCipherError,
  deriveTelegramTokenKey,
  isEncryptedTelegramToken,
  parseTelegramTokenKey,
} from './telegram-token.cipher';

/**
 * n0kLbx3d #3 — `telegram_markets.token` shifrlash yordamchisi (AES-256-GCM,
 * tasodifiy IV, `enc:v1:` prefiksi, eski ochiq matn bilan orqaga moslik).
 */
const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const SMS_SECRET = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
const BOT_TOKEN = '7012345678:AAH9sQwErTyUiOpAsDfGhJkLzXcVbNm1234';
const PLAIN = '123456789:AAF-secret_bot_token_value_xyz';

const envOf =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

const cipherWith = (env: Record<string, string>) =>
  TelegramTokenCipher.fromEnv(envOf(env));

describe('TelegramTokenCipher (n0kLbx3d #3)', () => {
  describe('shifrlash/ochish aylanishi', () => {
    it('round-trip: enc:v1: prefiksi, ochiq matn shifrda yo‘q, ochilganda asl qiymat', () => {
      const cipher = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A });
      const enc = cipher.encrypt(PLAIN);
      expect(enc.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(enc).not.toContain(PLAIN);
      expect(enc).not.toContain('secret_bot_token');
      expect(isEncryptedTelegramToken(enc)).toBe(true);
      expect(cipher.decrypt(enc)).toBe(PLAIN);
    });

    it('har yozuvga tasodifiy IV — bir xil token ikki xil shifr beradi', () => {
      const cipher = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A });
      const a = cipher.encrypt(PLAIN);
      const b = cipher.encrypt(PLAIN);
      expect(a).not.toBe(b);
      expect(a.split(':')[2]).not.toBe(b.split(':')[2]); // IV
      expect(cipher.decrypt(a)).toBe(PLAIN);
      expect(cipher.decrypt(b)).toBe(PLAIN);
    });

    it('format: enc:v1:<iv 12B>:<tag 16B>:<ciphertext> (base64url)', () => {
      const enc = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).encrypt(PLAIN);
      const [, , iv, tag, data] = enc.split(':');
      expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
      expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
      expect(Buffer.from(data, 'base64url').length).toBeGreaterThan(0);
      expect(enc).toMatch(
        /^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
      );
    });
  });

  describe('eski ochiq matn (orqaga moslik)', () => {
    it('prefikssiz qiymat shundayligicha qaytadi', () => {
      const cipher = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A });
      expect(cipher.decrypt(PLAIN)).toBe(PLAIN);
      expect(cipher.decrypt('group_token-abcdef0123456789')).toBe(
        'group_token-abcdef0123456789',
      );
      expect(isEncryptedTelegramToken(PLAIN)).toBe(false);
    });

    it('kalitsiz ham eski ochiq matn o‘qiladi', () => {
      expect(cipherWith({}).decrypt(PLAIN)).toBe(PLAIN);
    });
  });

  describe('noto‘g‘ri kalit / buzilgan shifr — aniq xato, token chiqmaydi', () => {
    const expectCleanError = (fn: () => unknown) => {
      let caught: unknown;
      try {
        fn();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TelegramTokenCipherError);
      const message = (caught as Error).message;
      expect(message).not.toContain(PLAIN);
      expect(message).not.toContain('secret_bot_token');
      expect(message).not.toContain(TELEGRAM_TOKEN_ENC_PREFIX);
      return message;
    };

    it('boshqa kalit bilan ochilmaydi', () => {
      const enc = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).encrypt(PLAIN);
      const message = expectCleanError(() =>
        cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_B }).decrypt(enc),
      );
      expect(message).toMatch(/ochib bo'lmadi/);
    });

    it('kalitsiz holatda shifrlangan qiymat — xato (ochiq matn deb qaytmaydi)', () => {
      const enc = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).encrypt(PLAIN);
      expectCleanError(() => cipherWith({}).decrypt(enc));
    });

    it('buzilgan ciphertext / tag / IV — autentifikatsiya xatosi', () => {
      const cipher = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A });
      const enc = cipher.encrypt(PLAIN);
      const parts = enc.split(':');
      const flip = (value: string) => {
        const buf = Buffer.from(value, 'base64url');
        buf[0] ^= 0xff;
        return buf.toString('base64url');
      };
      for (const index of [2, 3, 4]) {
        const tampered = [...parts];
        tampered[index] = flip(tampered[index]);
        expectCleanError(() => cipher.decrypt(tampered.join(':')));
      }
    });

    it.each([
      ['qism yetishmaydi', 'enc:v1:abc:def'],
      ['base64url emas', 'enc:v1:!!!:@@@:###'],
      ['IV uzunligi noto‘g‘ri', 'enc:v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA'],
      [
        'noma’lum versiya',
        'enc:v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA',
      ],
    ])('%s → xato', (_label, value) => {
      expectCleanError(() =>
        cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).decrypt(value),
      );
    });

    it('kalitsiz shifrlash — xato (ochiq matn yozilmaydi)', () => {
      expect(() => cipherWith({}).encrypt(PLAIN)).toThrow(
        /TELEGRAM_TOKEN_ENC_KEY/,
      );
    });
  });

  describe('kalit manbalari', () => {
    it('TELEGRAM_TOKEN_ENC_KEY: 64 hex yoki base64 / base64url (32 bayt)', () => {
      const raw = Buffer.from(KEY_A, 'hex');
      expect(parseTelegramTokenKey(KEY_A, 'K').equals(raw)).toBe(true);
      expect(
        parseTelegramTokenKey(raw.toString('base64'), 'K').equals(raw),
      ).toBe(true);
      expect(
        parseTelegramTokenKey(raw.toString('base64url'), 'K').equals(raw),
      ).toBe(true);
    });

    it.each([
      ['qisqa', 'abc123'],
      ['31 bayt hex', 'ab'.repeat(31)],
      ['parol', 'my-super-secret-passphrase-1234567890'],
    ])('noto‘g‘ri TELEGRAM_TOKEN_ENC_KEY (%s) → xato (fail-fast)', (_l, v) => {
      expect(() => cipherWith({ TELEGRAM_TOKEN_ENC_KEY: v })).toThrow(
        /TELEGRAM_TOKEN_ENC_KEY noto'g'ri/,
      );
    });

    it('env yo‘q → SMS_CREDENTIAL_SECRET dan HKDF (SMS sha256 kalitidan farqli)', () => {
      const cipher = cipherWith({
        SMS_CREDENTIAL_SECRET: SMS_SECRET,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      });
      expect(cipher.configured).toBe(true);
      expect(cipher.keySource).toBe('hkdf:SMS_CREDENTIAL_SECRET');
      const derived = deriveTelegramTokenKey(SMS_SECRET);
      expect(derived).toHaveLength(32);
      // SmsCredentialCipher sha256(secret) ishlatadi — kalitlar ajratilgan.
      expect(
        derived.equals(createHash('sha256').update(SMS_SECRET).digest()),
      ).toBe(false);
      const enc = cipher.encrypt(PLAIN);
      expect(
        new TelegramTokenCipher(derived, 'hkdf:SMS_CREDENTIAL_SECRET').decrypt(
          enc,
        ),
      ).toBe(PLAIN);
    });

    it('SMS sir bo‘lmasa → TELEGRAM_BOT_TOKEN dan HKDF', () => {
      const cipher = cipherWith({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
      expect(cipher.keySource).toBe('hkdf:TELEGRAM_BOT_TOKEN');
      expect(cipher.decrypt(cipher.encrypt(PLAIN))).toBe(PLAIN);
    });

    it('namuna/qisqa qiymatlardan (replace_me) kalit hosil qilinmaydi → kalitsiz', () => {
      const cipher = cipherWith({
        TELEGRAM_BOT_TOKEN: 'replace_me',
        SMS_CREDENTIAL_SECRET: '',
      });
      expect(cipher.configured).toBe(false);
      expect(cipher.keySource).toBe('none');
    });

    it('hosil qilingan kalitdan aniq kalitga o‘tish: eski shifr ochiladi va qayta shifrlanadi', () => {
      const old = cipherWith({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }).encrypt(PLAIN);
      const next = cipherWith({
        TELEGRAM_TOKEN_ENC_KEY: KEY_A,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      });
      expect(next.keySource).toBe('TELEGRAM_TOKEN_ENC_KEY');
      expect(next.decrypt(old)).toBe(PLAIN);
      const resealed = next.resealIfNeeded(old) as string;
      expect(resealed.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(
        cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).decrypt(resealed),
      ).toBe(PLAIN);
      expect(next.resealIfNeeded(resealed)).toBeNull();
    });

    it('rotatsiya: TELEGRAM_TOKEN_ENC_KEY_PREVIOUS faqat ochish uchun', () => {
      const old = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A }).encrypt(PLAIN);
      const rotating = cipherWith({
        TELEGRAM_TOKEN_ENC_KEY: KEY_B,
        TELEGRAM_TOKEN_ENC_KEY_PREVIOUS: KEY_A,
      });
      expect(rotating.decrypt(old)).toBe(PLAIN);
      const resealed = rotating.resealIfNeeded(old) as string;
      expect(
        cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_B }).decrypt(resealed),
      ).toBe(PLAIN);
    });
  });

  describe('resealIfNeeded (backfill)', () => {
    const cipher = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_A });

    it('ochiq matn → yangi shifr; joriy kalitdagi shifr → null (idempotent)', () => {
      const sealed = cipher.resealIfNeeded(PLAIN) as string;
      expect(sealed.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(cipher.decrypt(sealed)).toBe(PLAIN);
      expect(cipher.resealIfNeeded(sealed)).toBeNull();
      expect(cipher.resealIfNeeded('')).toBeNull();
    });

    it('ochilmaydigan shifr → xato (ustidan yozilmaydi)', () => {
      const foreign = cipherWith({ TELEGRAM_TOKEN_ENC_KEY: KEY_B }).encrypt(
        PLAIN,
      );
      expect(() => cipher.resealIfNeeded(foreign)).toThrow(
        TelegramTokenCipherError,
      );
    });
  });
});
