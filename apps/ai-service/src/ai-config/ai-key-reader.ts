import type { EntityManager } from 'typeorm';
import { SecretCipher, aiProviderKeyAad } from '@app/common';

/**
 * Saqlangan kalitni o'qish va ochish — SOF (Nest DI'siz): ai-service
 * runtime provayderi VA pilot skripti (`scripts/ai/eval-batch-matrix.ts
 * --key-source=db`) shu funksiyani ishlatadi.
 *
 * Sukut — `active`; `id` berilsa — shu qator (faqat active/previous).
 * Ochib bo'lmasa `key: null, unreadable: true` (xato matni yo'q).
 */
export interface AiStoredKeyRow {
  id: string;
  status: 'active' | 'previous';
  label: string | null;
  key_hint: string;
  fingerprint: string;
  verify_state: string;
  verify_origin: 'verify' | 'runtime';
  verify_error_code: string | null;
  verified_at: Date | null;
  updatedAt: Date;
}

export type AiReadKeyResult =
  | { row: AiStoredKeyRow; key: string; unreadable: false }
  | { row: AiStoredKeyRow; key: null; unreadable: true };

export async function readAnthropicKey(
  manager: EntityManager,
  cipher: SecretCipher,
  appEnv: string,
  opts: { id?: string } = {},
): Promise<AiReadKeyResult | null> {
  const rows = await manager.query<
    (AiStoredKeyRow & { secret_enc: string | null })[]
  >(
    `SELECT "id", "status", "label", "key_hint", "fingerprint", "verify_state",
            "verify_origin", "verify_error_code", "verified_at", "updatedAt", "secret_enc"
       FROM ai_schema.ai_provider_keys
      WHERE "provider" = 'anthropic' AND "is_deleted" = false
        AND ${opts.id ? `"id" = $1 AND "status" IN ('active','previous')` : `"status" = 'active'`}
      LIMIT 1`,
    opts.id ? [opts.id] : [],
  );
  const raw = rows[0];
  if (!raw) return null;
  const { secret_enc, ...row } = raw;
  if (!secret_enc) return { row, key: null, unreadable: true };
  try {
    const key = cipher.decrypt(secret_enc, aiProviderKeyAad(appEnv, row.id));
    return { row, key, unreadable: false };
  } catch {
    return { row, key: null, unreadable: true };
  }
}
