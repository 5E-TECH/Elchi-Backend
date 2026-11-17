import { Inject, Injectable, Optional } from '@nestjs/common';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_BASE_URL,
  AI_CONFIG_ERROR_CODES,
  type AiConfigErrorCode,
  type AiKeyVerifyState,
} from '@app/common';

/**
 * Kalitni BEPUL tekshirish (be-brief D7): faqat `GET /v1/models`
 * (`models.list`). Pulli `messages.*` HECH QACHON chaqirilmaydi.
 *
 * Har nomzod kalit uchun qisqa umrli SDK mijozi: `maxRetries: 0`, manzil
 * MAHKAM (`https://api.anthropic.com`), `logLevel: 'warn'`, timeout —
 * deadline'gacha qolgan vaqt (≤ 5000 ms).
 *
 * Xatolar FAQAT tur/status bo'yicha tasniflanadi (matn bo'yicha emas):
 * ulanish (birinchi) → UNAVAILABLE; 401 → REJECTED; 403 → FORBIDDEN;
 * 400 → BAD_REQUEST; 402 / `billing_error` → BILLING; 429 →
 * UPSTREAM_RATE_LIMITED (+ retry-after); 5xx/529 → UNAVAILABLE.
 */
export interface AiCatalogModelRaw {
  id: string;
  display_name: string | null;
  created_at: string | null;
  max_input_tokens: number | null;
  max_tokens: number | null;
  /** `null` — API imkoniyatlarni bermadi (capability_unknown). */
  capabilities: {
    image_input: boolean | null;
    structured_outputs: boolean | null;
    effort: boolean | null;
    effort_levels: string[];
    thinking: boolean | null;
  } | null;
}

export type AiKeyVerifyResult =
  | { ok: true; models: AiCatalogModelRaw[] }
  | {
      ok: false;
      code: AiConfigErrorCode;
      state: AiKeyVerifyState;
      retry_after_seconds?: number;
    };

/** Faqat `models.list` kerak — soxta mijoz ham shu shaklda. */
export interface AiModelsListClient {
  models: {
    list(
      params: { limit: number },
      options?: { timeout?: number },
    ): AsyncIterable<unknown>;
  };
}

export type AiVerifierClientFactory = (o: {
  apiKey: string;
  timeout: number;
}) => AiModelsListClient;

export const AI_VERIFIER_CLIENT_FACTORY = Symbol('AI_VERIFIER_CLIENT_FACTORY');

export const defaultVerifierClientFactory: AiVerifierClientFactory = (o) =>
  new Anthropic({
    apiKey: o.apiKey,
    baseURL: ANTHROPIC_API_BASE_URL,
    logLevel: 'warn',
    maxRetries: 0,
    timeout: o.timeout,
  });

/** Katalog xavfsizlik chegarasi (sahifalash cheksiz aylanmasin). */
const MAX_MODELS = 1000;

function bool(node: unknown): boolean | null {
  if (!node || typeof node !== 'object') return null;
  const v = (node as { supported?: unknown }).supported;
  return typeof v === 'boolean' ? v : null;
}

/** Hujjatlashtirilgan ichki daraxt — himoyalangan o'qish (D10, spec §16). */
export function normalizeModel(raw: unknown): AiCatalogModelRaw | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id))
    return null;
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const caps =
    m.capabilities && typeof m.capabilities === 'object'
      ? (m.capabilities as Record<string, unknown>)
      : null;
  const effortNode =
    caps?.effort && typeof caps.effort === 'object'
      ? (caps.effort as Record<string, unknown>)
      : null;
  return {
    id: m.id,
    display_name:
      typeof m.display_name === 'string' ? m.display_name.slice(0, 80) : null,
    created_at: typeof m.created_at === 'string' ? m.created_at : null,
    max_input_tokens: num(m.max_input_tokens),
    max_tokens: num(m.max_tokens),
    capabilities: caps
      ? {
          image_input: bool(caps.image_input),
          structured_outputs: bool(caps.structured_outputs),
          effort: bool(effortNode),
          effort_levels: effortNode
            ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(
                (l) => bool(effortNode[l]) === true,
              )
            : [],
          thinking: bool(caps.thinking),
        }
      : null,
  };
}

function retryAfterSeconds(err: APIError): number | undefined {
  const raw = err.headers?.get?.('retry-after');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 3600) : 60;
}

/** Xatoni kodga aylantiradi. Matn hech qachon o'qilmaydi/qaytmaydi. */
export function classifyVerifyError(
  err: unknown,
): Extract<AiKeyVerifyResult, { ok: false }> {
  const C = AI_CONFIG_ERROR_CODES;
  if (
    err instanceof APIConnectionTimeoutError ||
    err instanceof APIConnectionError
  ) {
    return { ok: false, code: C.KEY_VERIFY_UNAVAILABLE, state: 'unavailable' };
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 402 || err.type === 'billing_error')
      return { ok: false, code: C.KEY_BILLING, state: 'billing' };
    if (status === 401)
      return { ok: false, code: C.KEY_REJECTED, state: 'rejected' };
    if (status === 403)
      return { ok: false, code: C.KEY_FORBIDDEN, state: 'forbidden' };
    if (status === 400)
      return { ok: false, code: C.KEY_BAD_REQUEST, state: 'bad_request' };
    if (status === 429)
      return {
        ok: false,
        code: C.KEY_UPSTREAM_RATE_LIMITED,
        state: 'unavailable',
        retry_after_seconds: retryAfterSeconds(err),
      };
  }
  return { ok: false, code: C.KEY_VERIFY_UNAVAILABLE, state: 'unavailable' };
}

@Injectable()
export class AiKeyVerifierService {
  private readonly factory: AiVerifierClientFactory;

  constructor(
    @Optional()
    @Inject(AI_VERIFIER_CLIENT_FACTORY)
    factory?: AiVerifierClientFactory,
  ) {
    this.factory = factory ?? defaultVerifierClientFactory;
  }

  /**
   * `timeoutMs` ≤ 0 — tarmoqqa chiqilmaydi (deadline o'tgan → UNAVAILABLE,
   * chaqiruvchi EXPIRED qaytaradi).
   */
  async verify(apiKey: string, timeoutMs: number): Promise<AiKeyVerifyResult> {
    if (timeoutMs <= 0) {
      return {
        ok: false,
        code: AI_CONFIG_ERROR_CODES.KEY_VERIFY_UNAVAILABLE,
        state: 'unavailable',
      };
    }
    const timeout = Math.min(5000, Math.floor(timeoutMs));
    const startedAt = Date.now();
    try {
      const client = this.factory({ apiKey, timeout });
      const models: AiCatalogModelRaw[] = [];
      for await (const raw of client.models.list(
        { limit: 1000 },
        { timeout },
      )) {
        const m = normalizeModel(raw);
        if (m) models.push(m);
        if (models.length >= MAX_MODELS) break;
        // Sahifalash umumiy deadline'dan oshmasin.
        if (Date.now() - startedAt > timeout) {
          return {
            ok: false,
            code: AI_CONFIG_ERROR_CODES.KEY_VERIFY_UNAVAILABLE,
            state: 'unavailable',
          };
        }
      }
      return { ok: true, models };
    } catch (err) {
      return classifyVerifyError(err);
    }
  }
}
