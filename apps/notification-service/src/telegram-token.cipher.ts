import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';

/**
 * `telegram_markets.token` (market bot tokeni) ni DB'da shifrlash (n0kLbx3d #3).
 *
 * AES-256-GCM (autentifikatsiyalangan), har yozuvga tasodifiy 12 baytlik IV,
 * versiya prefiksi bilan:
 *
 *   `enc:v1:<iv base64url>:<tag base64url>:<ciphertext base64url>`
 *
 * Tasodifiy IV sabab bir xil token har safar boshqa qiymat beradi — token
 * bo'yicha WHERE qidiruv ISHLAMAYDI (kodda bunday qidiruv yo'q va bo'lmasligi
 * kerak). Shuning uchun shifrlash TypeORM transformer'ida emas, servis
 * qatlamida (sabablar — `NotificationServiceService` dagi izohda).
 *
 * Kalit tartibi (`TelegramTokenCipher.fromEnv`):
 *  1. `TELEGRAM_TOKEN_ENC_KEY` — 32 bayt (64 hex yoki base64). Noto'g'ri format
 *     → start xatosi (boshqa maxfiy env'lardagi Joi tekshiruvi kabi fail-fast).
 *  2. Berilmasa — notification-service'ning boshqa maxfiy env'idan HKDF-SHA256:
 *     `SMS_CREDENTIAL_SECRET`, u bo'sh bo'lsa `TELEGRAM_BOT_TOKEN` (≥32 belgi;
 *     `replace_me` kabi namunalar olinmaydi). Servis yiqilmaydi, start'da WARN.
 *  3. Hech biri yo'q — shifrlash o'chiq: yangi bot tokeni saqlanmaydi (400),
 *     eski ochiq matnli qatorlar o'qilaveradi.
 *
 * Ochish qo'shimcha (faqat o'qish uchun) kalitlarni ham sinaydi:
 * `TELEGRAM_TOKEN_ENC_KEY_PREVIOUS`, `SMS_CREDENTIAL_SECRET_PREVIOUS` va boshqa
 * manbadan hosil qilingan kalitlar. Shunda manba almashganda (masalan keyinroq
 * `TELEGRAM_TOKEN_ENC_KEY` qo'yilganda) eski shifrlar yo'qolmaydi — start'dagi
 * backfill ularni joriy kalitga qayta shifrlaydi.
 *
 * Prefikssiz qiymat — eski OCHIQ MATN (orqaga moslik): shundayligicha qaytadi.
 * `enc:` bilan boshlanib noma'lum versiya / buzilgan / boshqa kalitdagi qiymat —
 * XATO (`TelegramTokenCipherError`, matnida token yo'q); jimgina "ochiq matn"
 * deb qaytmaydi (fail-closed).
 */
export const TELEGRAM_TOKEN_ENC_PREFIX = 'enc:v1:';

/** Har qanday versiyadagi shifr belgisi (bot tokeni hech qachon shunday boshlanmaydi). */
const ENC_MARKER = 'enc:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Shifr faqat shu ustun uchun yaroqli (boshqa joydagi GCM qiymati bilan almashtirib bo'lmaydi). */
const AAD = Buffer.from('elchi:notification:telegram_markets.token:v1', 'utf8');
const HKDF_SALT = 'elchi:notification-service';
const HKDF_INFO = 'telegram_markets.token:enc:v1';
/** Derivatsiya manbai shundan qisqa bo'lsa (namuna/placeholder) olinmaydi. */
const MIN_DERIVE_SECRET_LENGTH = 32;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Kalit qaysi env'dan olingani (WARN log va hisobot uchun; qiymat emas). */
export type TelegramTokenKeySource =
  | 'TELEGRAM_TOKEN_ENC_KEY'
  | 'hkdf:SMS_CREDENTIAL_SECRET'
  | 'hkdf:TELEGRAM_BOT_TOKEN'
  | 'none';

/** Derivatsiya manbalari — ustuvorlik tartibida. */
const DERIVE_SOURCES = ['SMS_CREDENTIAL_SECRET', 'TELEGRAM_BOT_TOKEN'] as const;

/** Shifrlash/ochish xatosi. Xabarida token (ochiq yoki shifr) HECH QACHON yo'q. */
export class TelegramTokenCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramTokenCipherError';
  }
}

export const TELEGRAM_TOKEN_UNREADABLE_MESSAGE =
  "Telegram bot tokenini ochib bo'lmadi — shifrlash kaliti mos emas yoki saqlangan qiymat buzilgan (TELEGRAM_TOKEN_ENC_KEY ni tekshiring yoki tokenni PATCH /notifications/:id orqali qayta kiriting)";

export const TELEGRAM_TOKEN_NO_KEY_MESSAGE =
  'Telegram bot tokenini xavfsiz saqlash kaliti sozlanmagan (TELEGRAM_TOKEN_ENC_KEY) — token saqlanmadi';

/** Qiymat shifrlangan formatdami (`enc:` — versiyadan qat'i nazar). */
export function isEncryptedTelegramToken(value?: string | null): boolean {
  return typeof value === 'string' && value.startsWith(ENC_MARKER);
}

/** `TELEGRAM_TOKEN_ENC_KEY` qiymati → 32 baytlik kalit (64 hex yoki base64/base64url). */
export function parseTelegramTokenKey(raw: string, envName: string): Buffer {
  const value = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new TelegramTokenCipherError(
      `${envName} noto'g'ri: 32 bayt bo'lishi kerak (64 hex yoki base64; yaratish: openssl rand -hex 32)`,
    );
  }
  return key;
}

/** Boshqa maxfiy env'dan alohida (domen-ajratilgan) 32 baytlik kalit. */
export function deriveTelegramTokenKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_BYTES),
  );
}

const fromB64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

type EnvGetter = (key: string) => string | null | undefined;

export class TelegramTokenCipher {
  private readonly decryptOnly: Buffer[];

  constructor(
    private readonly primary: Buffer | null,
    readonly keySource: TelegramTokenKeySource,
    decryptOnlyKeys: Buffer[] = [],
  ) {
    const seen: Buffer[] = primary ? [primary] : [];
    this.decryptOnly = decryptOnlyKeys.filter((key) => {
      if (seen.some((other) => other.equals(key))) return false;
      seen.push(key);
      return true;
    });
  }

  /** Env'dan kalitlarni yig'adi. Noto'g'ri formatdagi aniq kalit → xato. */
  static fromEnv(get: EnvGetter): TelegramTokenCipher {
    const read = (name: string): string => {
      const value = get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const explicit = (name: string): Buffer | null => {
      const value = read(name);
      return value ? parseTelegramTokenKey(value, name) : null;
    };
    const derived = (name: string): Buffer | null => {
      const value = read(name);
      return value.length >= MIN_DERIVE_SECRET_LENGTH
        ? deriveTelegramTokenKey(value)
        : null;
    };

    const envKey = explicit('TELEGRAM_TOKEN_ENC_KEY');
    const derivedKeys = DERIVE_SOURCES.map((name) => ({
      name,
      key: derived(name),
    })).filter(
      (item): item is { name: (typeof DERIVE_SOURCES)[number]; key: Buffer } =>
        Boolean(item.key),
    );

    let primary: Buffer | null = null;
    let source: TelegramTokenKeySource = 'none';
    if (envKey) {
      primary = envKey;
      source = 'TELEGRAM_TOKEN_ENC_KEY';
    } else if (derivedKeys.length) {
      primary = derivedKeys[0].key;
      source = `hkdf:${derivedKeys[0].name}`;
    }

    const decryptOnly = [
      explicit('TELEGRAM_TOKEN_ENC_KEY_PREVIOUS'),
      ...derivedKeys.map((item) => item.key),
      derived('SMS_CREDENTIAL_SECRET_PREVIOUS'),
    ].filter((key): key is Buffer => Boolean(key));

    return new TelegramTokenCipher(primary, source, decryptOnly);
  }

  get configured(): boolean {
    return this.primary !== null;
  }

  encrypt(plain: string): string {
    if (!this.primary) {
      throw new TelegramTokenCipherError(TELEGRAM_TOKEN_NO_KEY_MESSAGE);
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.primary, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${TELEGRAM_TOKEN_ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
  }

  /** Saqlangan qiymat → ochiq token. Prefikssiz qiymat — eski ochiq matn. */
  decrypt(stored: string): string {
    return this.open(stored).plain;
  }

  /**
   * Backfill uchun: qiymatni joriy kalit bilan (qayta) shifrlash kerak bo'lsa
   * yangi qiymat, kerak bo'lmasa `null`. Ochilmaydigan shifr → xato.
   */
  resealIfNeeded(stored: string): string | null {
    if (!stored) return null;
    const { plain, byPrimary } = this.open(stored);
    return byPrimary ? null : this.encrypt(plain);
  }

  private open(stored: string): { plain: string; byPrimary: boolean } {
    if (!isEncryptedTelegramToken(stored)) {
      return { plain: stored, byPrimary: false };
    }
    if (!stored.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)) {
      throw new TelegramTokenCipherError(
        "Telegram bot tokeni noma'lum shifr versiyasida — ochib bo'lmadi",
      );
    }
    const parts = stored.slice(TELEGRAM_TOKEN_ENC_PREFIX.length).split(':');
    if (parts.length !== 3 || !parts.every((part) => B64URL_RE.test(part))) {
      throw new TelegramTokenCipherError(TELEGRAM_TOKEN_UNREADABLE_MESSAGE);
    }
    const [iv, tag, data] = parts.map(fromB64url);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !data.length) {
      throw new TelegramTokenCipherError(TELEGRAM_TOKEN_UNREADABLE_MESSAGE);
    }

    const keys = this.primary
      ? [this.primary, ...this.decryptOnly]
      : this.decryptOnly;
    for (const key of keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([
          decipher.update(data),
          decipher.final(),
        ]).toString('utf8');
        return { plain, byPrimary: key === this.primary };
      } catch {
        // keyingi kalit (rotatsiya / manba almashgan)
      }
    }
    throw new TelegramTokenCipherError(TELEGRAM_TOKEN_UNREADABLE_MESSAGE);
  }
}
