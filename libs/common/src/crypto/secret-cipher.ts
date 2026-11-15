import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * DB'dagi maxfiy qiymatlarni shifrlash (AES-256-GCM, autentifikatsiyalangan).
 *
 * `apps/notification-service/src/sms/sms-credential.cipher.ts` dan
 * umumlashtirilgan (SMS o'z nusxasida qoladi). Farqlari:
 * - kalit HKDF-SHA256 bilan olinadi (`info` — maqsad bo'yicha alohida);
 * - har qiymat AAD bilan bog'lanadi (masalan
 *   `elchi/<APP_ENV>/ai_provider_keys/<id>`): boshqa qatorga yoki boshqa
 *   muhitga ko'chirilgan shifrmatn OCHILMAYDI;
 * - format versiyali: `enc:gcm:v1:<iv hex>:<tag hex>:<ct hex>`.
 *
 * Fail-closed: buzilgan, boshqa kalit yoki boshqa AAD → xato. Xato matnida
 * HECH QACHON ochiq matn, sir yoki shifrmatn bo'lmaydi.
 */
export const SECRET_CIPHER_PREFIX = 'enc:gcm:v1:';
export const AI_PROVIDER_KEY_HKDF_INFO = 'elchi/ai-provider-key/v1';

/** Master sir uchun minimal uzunlik (belgi). */
export const SECRET_CIPHER_MIN_SECRET_LENGTH = 32;

export class SecretCipherError extends Error {
  constructor(
    readonly code:
      'not_configured' | 'bad_format' | 'decrypt_failed' | 'bad_secret',
    message: string,
  ) {
    super(message);
    this.name = 'SecretCipherError';
  }
}

export interface SecretCipherOptions {
  /** Joriy master sir (fayl mazmuni). Yo'q — shifrlash o'chiq. */
  primary: string | null | undefined;
  /** Rotatsiya paytida eski master sir (faqat ochish uchun). */
  previous?: string | null;
  /** HKDF `info` — maqsad bo'yicha alohida kalit. */
  info?: string;
}

function deriveKey(secret: string, info: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.length < SECRET_CIPHER_MIN_SECRET_LENGTH) {
    throw new SecretCipherError(
      'bad_secret',
      `master sir juda qisqa (kamida ${SECRET_CIPHER_MIN_SECRET_LENGTH} belgi)`,
    );
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(trimmed, 'utf8'), Buffer.alloc(0), info, 32),
  );
}

interface Parsed {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

function parse(value: string): Parsed {
  if (typeof value !== 'string' || !value.startsWith(SECRET_CIPHER_PREFIX)) {
    throw new SecretCipherError('bad_format', 'shifrmatn formati noto‘g‘ri');
  }
  const parts = value.slice(SECRET_CIPHER_PREFIX.length).split(':');
  const hex = /^[0-9a-f]+$/;
  if (
    parts.length !== 3 ||
    !parts.every((p) => p.length > 0 && p.length % 2 === 0 && hex.test(p))
  ) {
    throw new SecretCipherError('bad_format', 'shifrmatn formati buzilgan');
  }
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'hex'));
  if (iv.length !== 12 || tag.length !== 16) {
    throw new SecretCipherError('bad_format', 'shifrmatn formati buzilgan');
  }
  return { iv, tag, ct };
}

function open(key: Buffer, p: Parsed, aad: string): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, p.iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(p.tag);
    return Buffer.concat([d.update(p.ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export class SecretCipher {
  private readonly primary: Buffer | null;
  private readonly previous: Buffer | null;

  constructor(opts: SecretCipherOptions) {
    const info = opts.info ?? AI_PROVIDER_KEY_HKDF_INFO;
    this.primary = opts.primary ? deriveKey(opts.primary, info) : null;
    this.previous = opts.previous ? deriveKey(opts.previous, info) : null;
  }

  /** Joriy master sir bor (shifrlash mumkin). */
  get configured(): boolean {
    return this.primary !== null;
  }

  /** Rotatsiya rejimi (`_PREVIOUS` sir berilgan). */
  get rotating(): boolean {
    return this.previous !== null;
  }

  encrypt(plain: string, aad: string): string {
    if (!this.primary) {
      throw new SecretCipherError('not_configured', 'master sir sozlanmagan');
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.primary, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return `${SECRET_CIPHER_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
  }

  decrypt(value: string, aad: string): string {
    if (!this.primary && !this.previous) {
      throw new SecretCipherError('not_configured', 'master sir sozlanmagan');
    }
    const p = parse(value);
    const plain =
      (this.primary ? open(this.primary, p, aad) : null) ??
      (this.previous ? open(this.previous, p, aad) : null);
    if (plain === null) {
      throw new SecretCipherError(
        'decrypt_failed',
        'shifrmatnni ochib bo‘lmadi (kalit yoki AAD mos emas)',
      );
    }
    return plain;
  }

  /**
   * Qiymat joriy kalit bilan ochilmaydi, lekin oldingisi bilan ochiladi —
   * qayta shifrlash kerak. Ochilmaydigan qiymat uchun `false` (u
   * "unreadable", rotatsiya emas).
   */
  needsReencrypt(value: string, aad: string): boolean {
    if (!this.previous || !this.primary) return false;
    let p: Parsed;
    try {
      p = parse(value);
    } catch {
      return false;
    }
    if (open(this.primary, p, aad) !== null) return false;
    return open(this.previous, p, aad) !== null;
  }
}

/** `elchi/<APP_ENV>/ai_provider_keys/<id>` — kalit qatori AAD'si. */
export function aiProviderKeyAad(appEnv: string, id: string): string {
  return `elchi/${appEnv}/ai_provider_keys/${id}`;
}

export interface AiKeyMasterSecrets {
  primary: string | null;
  previous: string | null;
  /** Qayerdan o'qildi (log uchun — qiymat emas). */
  source: 'file' | 'env' | 'none';
}

/**
 * AI kalit master sirini o'qiydi: `AI_KEY_ENCRYPTION_SECRET_FILE` /
 * `AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE` (0400 bind mount). Oddiy env
 * (`AI_KEY_ENCRYPTION_SECRET`) faqat `APP_ENV=development` da qabul qilinadi.
 * Fayl o'qilmasa — xato (matnda faqat env NOMI, yo'l yoki mazmun emas).
 */
export function loadAiKeyMasterSecrets(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): AiKeyMasterSecrets {
  const fromFile = (name: string): string | null => {
    const path = (env[name] ?? '').trim();
    if (!path) return null;
    try {
      const v = read(path).trim();
      return v || null;
    } catch {
      throw new SecretCipherError(
        'bad_secret',
        `${name} faylini o‘qib bo‘lmadi`,
      );
    }
  };
  const primary = fromFile('AI_KEY_ENCRYPTION_SECRET_FILE');
  const previous = fromFile('AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE');
  if (primary) return { primary, previous, source: 'file' };
  if ((env.APP_ENV ?? '').trim() === 'development') {
    const p = (env.AI_KEY_ENCRYPTION_SECRET ?? '').trim() || null;
    const prev = (env.AI_KEY_ENCRYPTION_SECRET_PREVIOUS ?? '').trim() || null;
    if (p) return { primary: p, previous: prev ?? previous, source: 'env' };
  }
  return { primary: null, previous, source: 'none' };
}
