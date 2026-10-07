import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/**
 * SMS provayder kredensiallarini DB'da shifrlash (8auPBa1O #2).
 *
 * integration-service naqshi (`enc:` prefiksi, sha256(secret) kalit,
 * PREVIOUS kalit bilan rotatsiya), lekin AES-256-GCM — autentifikatsiyalangan:
 * buzilgan/boshqa kalitdagi qiymat jimgina "ochiq matn" deb qaytmaydi, XATO
 * beradi (fail-closed).
 *
 * Format: `enc:gcm:<iv hex>:<tag hex>:<ciphertext hex>`
 */
const PREFIX = 'enc:gcm:';

const keyOf = (secret: string): Buffer =>
  createHash('sha256').update(secret, 'utf8').digest();

export class SmsCredentialCipher {
  private readonly primary: Buffer | null;
  private readonly previous: Buffer | null;

  constructor(secret?: string | null, previousSecret?: string | null) {
    this.primary = secret ? keyOf(secret) : null;
    this.previous = previousSecret ? keyOf(previousSecret) : null;
  }

  get configured(): boolean {
    return this.primary !== null;
  }

  encrypt(plain: string): string {
    if (!this.primary) {
      throw new Error(
        "SMS_CREDENTIAL_SECRET sozlanmagan — kredensial saqlab bo'lmaydi",
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.primary, iv);
    const encrypted = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(value: string): string {
    if (!value.startsWith(PREFIX)) {
      throw new Error('Kredensial shifrlanmagan formatda — rad etildi');
    }
    const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':');
    if (!ivHex || !tagHex || !dataHex)
      throw new Error('Kredensial formati buzilgan');
    const attempt = (key: Buffer | null): string | null => {
      if (!key) return null;
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(ivHex, 'hex'),
        );
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataHex, 'hex')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return null;
      }
    };
    const plain = attempt(this.primary) ?? attempt(this.previous);
    if (plain === null)
      throw new Error("Kredensialni deshifrlab bo'lmadi (kalit mos emas)");
    return plain;
  }

  /** Qiymat PREVIOUS kalit bilan shifrlangan bo'lsa (rotatsiya kerak). */
  needsReencrypt(value: string): boolean {
    if (!this.previous) return false;
    try {
      const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.primary as Buffer,
        Buffer.from(ivHex, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      decipher.update(Buffer.from(dataHex, 'hex'));
      decipher.final();
      return false;
    } catch {
      return true;
    }
  }
}
