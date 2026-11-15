import { Injectable } from '@nestjs/common';
import {
  KeyObject,
  createDecipheriv,
  createHash,
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import type { AiKeyEnvelope, AiKeyWrapView } from '@app/common';

/**
 * Kalit konverti (be-brief §5.2, D3): brauzer kalitni ai-service'ning
 * boot paytida yaratilgan RSA-OAEP-256 ochiq kaliti bilan muhrlaydi
 * (+ AES-256-GCM). Cloudflare, gateway, RMQ, Sentry faqat shifrmatnni
 * ko'radi. Maxfiy kalit FAQAT xotirada (diskka/DB'ga yozilmaydi) — qayta
 * ishga tushgandan keyin eski konvert foydasiz (`AI_KEY_WRAP_STALE`).
 *
 * ⚠️ BITTA NUSXA (prod va staging bitta ai-service). Ko'paytirishdan oldin
 * wrap kalit juftini `ai_runtime_settings` ga SecretCipher bilan shifrlab
 * ko'chirish kerak — aks holda har ikkinchi so'rov STALE oladi.
 *
 * ⚠️ MAXFIYLIK: hech bir qiymat (konvert, ochilgan JSON, kalit, nonce)
 * logga yoki xato matniga tushmaydi — natija faqat kod.
 */
export const AI_KEY_WRAP_ALG = 'RSA-OAEP-256+A256GCM' as const;
export const AI_KEY_WRAP_AAD_PREFIX = 'elchi/ai-key-wrap/v1|';
/** Ko'rilgan nonce'lar (takror yuborishga qarshi), xotira chegarasi. */
export const AI_KEY_WRAP_NONCE_CAP = 10_000;

export type AiKeyEnvelopeOpenResult =
  | { ok: true; apiKey: string }
  | { ok: false; code: 'AI_KEY_WRAP_STALE' | 'AI_KEY_WRAP_INVALID' };

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64url(value: unknown, min: number, max: number): Buffer | null {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    return null;
  if (!B64URL.test(value)) return null;
  return Buffer.from(value, 'base64url');
}

@Injectable()
export class AiKeyEnvelopeService {
  private readonly privateKey: KeyObject;
  private readonly spkiB64: string;
  readonly kid: string;
  private readonly seenNonces = new Set<string>();

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
    });
    this.privateKey = privateKey;
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    this.spkiB64 = spki.toString('base64');
    this.kid = createHash('sha256').update(spki).digest('hex').slice(0, 16);
  }

  /** GET /ai/config `key_wrap` (yozish mumkin bo'lganda). */
  view(): AiKeyWrapView {
    return {
      kid: this.kid,
      alg: AI_KEY_WRAP_ALG,
      public_key_spki: this.spkiB64,
    };
  }

  /**
   * Konvertni ochadi. `uid` — imzolangan requester id'si (gateway
   * imzosidan). Noma'lum kid → STALE; har qanday kripto/JSON xatosi, boshqa
   * foydalanuvchi, takroriy nonce → INVALID. Format (D8) bu yerda EMAS —
   * chaqiruvchi `checkAiKeyFormat` bilan tekshiradi.
   */
  open(envelope: unknown, uid: string): AiKeyEnvelopeOpenResult {
    const invalid = { ok: false, code: 'AI_KEY_WRAP_INVALID' } as const;
    if (!envelope || typeof envelope !== 'object') return invalid;
    const e = envelope as Partial<AiKeyEnvelope>;
    if (e.v !== 1 || e.alg !== AI_KEY_WRAP_ALG) return invalid;
    if (typeof e.kid !== 'string' || !/^[0-9a-f]{16}$/.test(e.kid))
      return invalid;
    if (e.kid !== this.kid) return { ok: false, code: 'AI_KEY_WRAP_STALE' };
    const ek = b64url(e.ek, 400, 700);
    const iv = b64url(e.iv, 16, 16);
    const ct = b64url(e.ct, 40, 1024);
    if (!ek || !iv || !ct || iv.length !== 12 || ct.length <= 16)
      return invalid;

    let plain: string;
    try {
      const aesKey = privateDecrypt(
        {
          key: this.privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        ek,
      );
      if (aesKey.length !== 32) return invalid;
      const d = createDecipheriv('aes-256-gcm', aesKey, iv);
      d.setAAD(Buffer.from(AI_KEY_WRAP_AAD_PREFIX + this.kid, 'utf8'));
      d.setAuthTag(ct.subarray(ct.length - 16));
      plain = Buffer.concat([
        d.update(ct.subarray(0, ct.length - 16)),
        d.final(),
      ]).toString('utf8');
    } catch {
      return invalid;
    }

    let body: { api_key?: unknown; uid?: unknown; nonce?: unknown };
    try {
      body = JSON.parse(plain) as typeof body;
    } catch {
      return invalid;
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.api_key !== 'string' ||
      typeof body.uid !== 'string' ||
      typeof body.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(body.nonce)
    ) {
      return invalid;
    }
    if (body.uid !== String(uid)) return invalid;
    if (this.seenNonces.has(body.nonce)) return invalid;
    if (this.seenNonces.size >= AI_KEY_WRAP_NONCE_CAP) {
      // Eng eski yarmini tashlaymiz (Set kiritish tartibini saqlaydi).
      let drop = Math.floor(AI_KEY_WRAP_NONCE_CAP / 2);
      for (const n of this.seenNonces) {
        if (drop-- <= 0) break;
        this.seenNonces.delete(n);
      }
    }
    this.seenNonces.add(body.nonce);
    return { ok: true, apiKey: body.api_key };
  }
}
