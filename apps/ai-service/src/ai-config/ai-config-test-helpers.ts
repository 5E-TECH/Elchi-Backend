import { webcrypto } from 'node:crypto';
import type { AiKeyEnvelope, AiKeyWrapView } from '@app/common';

/**
 * Faqat testlar: brauzer (WebCrypto) kabi konvert muhrlash — FE bilan bir
 * xil parametrlar: RSA-OAEP SHA-256 + AES-256-GCM, AAD
 * `elchi/ai-key-wrap/v1|<kid>`. Kalitlar soxta.
 */
export const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40);
export const FAKE_KEY_2 = 'sk-ant-api03-' + 'y'.repeat(40);

export async function sealForTest(
  wrap: AiKeyWrapView,
  body: { api_key: string; uid: string; nonce?: string },
): Promise<AiKeyEnvelope> {
  const subtle = webcrypto.subtle;
  const pub = await subtle.importKey(
    'spki',
    Buffer.from(wrap.public_key_spki, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
  ]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const nonce =
    body.nonce ??
    Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString(
      'base64url',
    );
  const ct = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: Buffer.from(`elchi/ai-key-wrap/v1|${wrap.kid}`, 'utf8'),
    },
    aes,
    Buffer.from(
      JSON.stringify({ api_key: body.api_key, uid: body.uid, nonce }),
    ),
  );
  const raw = await subtle.exportKey('raw', aes);
  const ek = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw);
  return {
    v: 1,
    kid: wrap.kid,
    alg: 'RSA-OAEP-256+A256GCM',
    ek: Buffer.from(ek).toString('base64url'),
    iv: Buffer.from(iv).toString('base64url'),
    ct: Buffer.from(ct).toString('base64url'),
  };
}
