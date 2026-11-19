import { Logger } from '@nestjs/common';
import { inspectAnthropicEnv } from './ai-key-check';
import { fingerprintOf } from './ai-key-format';
import {
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
} from './claude.constants';
import type {
  AnthropicClientFactory,
  AnthropicClientLike,
  AnthropicKeyInspection,
} from './claude.types';

/**
 * «AI kalit va modellar» (be-brief §7): Anthropic mijozini kim beradi.
 *
 * `ClaudeService` endi qat'iy `client` saqlamaydi — har `extractJson` boshida
 * va har `runToolLoop` uchun BITTA lease oladi (sikl o'rtasida kalit
 * almashsa ham boshlangan sikl o'z kalitida tugaydi). `acquire()` SINXRON va
 * faqat xotiradan (DB/tarmoq yo'q).
 *
 * Sukut — `EnvAnthropicClientProvider`: bugungi xulq (ANTHROPIC_API_KEY bir
 * marta o'qiladi). ai-service o'zining runtime provayderini (UI > env > yo'q)
 * `ANTHROPIC_CLIENT_PROVIDER` orqali beradi.
 */
export interface AnthropicClientLease {
  client: AnthropicClientLike;
  /** UI kaliti qatori id'si; env kalitida null. */
  keyId: string | null;
  source: 'ui' | 'env';
  /** `fingerprintOf(key)` — kalit qiymati emas. */
  fingerprint: string;
  /** Runtime sozlama versiyasi (env provayderida 0). */
  configVersion: number;
}

/** Natija turi (slot salomatligi uchun, BE-4). */
export type AiCallOutcome =
  'ok' | 'truncated' | 'refused' | 'invalid_json' | 'rate_limited' | 'error';

export interface AnthropicClientProvider {
  /** Sinxron, faqat xotira. `null` — AI o'chiq (kalit yo'q / rad etilgan / ochilmadi). */
  acquire(): AnthropicClientLease | null;
  /** `ai.status.key_state` (mavjud semantika: ok | missing | misnamed). */
  keyState(): AnthropicKeyInspection;
  /**
   * Haqiqiy chaqiruv xatosi (FAQAT tur/status bo'yicha tasniflanadi).
   * `feature` — `ai_usage_log.feature` (slotga provayder o'zi moslaydi).
   * HECH QACHON throw qilmaydi va chaqiruvchini kutdirmaydi.
   */
  reportCallFailure(
    lease: AnthropicClientLease,
    feature: string,
    err: unknown,
  ): void;
  /** Javob olingan chaqiruv natijasi (slot salomatligi). Throw yo'q. */
  reportCallOutcome(
    lease: AnthropicClientLease,
    feature: string,
    outcome: AiCallOutcome,
  ): void;
}

export const ANTHROPIC_CLIENT_PROVIDER = Symbol('ANTHROPIC_CLIENT_PROVIDER');

/** Mijoz qurish — xato bo'lsa null (servis baribir ko'tariladi). */
export function buildAnthropicClient(
  factory: AnthropicClientFactory,
  apiKey: string,
  logger?: Logger,
): AnthropicClientLike | null {
  try {
    return factory({
      apiKey,
      timeout: ANTHROPIC_TIMEOUT_MS,
      maxRetries: ANTHROPIC_MAX_RETRIES,
    });
  } catch (err) {
    const name =
      err instanceof Error ? err.constructor?.name || err.name : 'non-error';
    logger?.error(`Anthropic mijozi qurilmadi: ${name}`);
    return null;
  }
}

/**
 * Bugungi xulq: env kaliti bir marta o'qiladi, mijoz bir marta quriladi.
 * `enabled=false` (staging o'chiq) — mijoz UMUMAN qurilmaydi.
 */
export class EnvAnthropicClientProvider implements AnthropicClientProvider {
  private readonly lease: AnthropicClientLease | null;
  private readonly keyInfo: AnthropicKeyInspection;

  constructor(
    apiKey: string,
    factory: AnthropicClientFactory,
    enabled: boolean,
    logger?: Logger,
  ) {
    const client =
      apiKey && enabled ? buildAnthropicClient(factory, apiKey, logger) : null;
    this.lease = client
      ? {
          client,
          keyId: null,
          source: 'env',
          fingerprint: fingerprintOf(apiKey),
          configVersion: 0,
        }
      : null;
    // Faqat NOMLAR — qiymat o'qilmaydi va logga chiqmaydi.
    const scan = inspectAnthropicEnv(process.env);
    this.keyInfo = apiKey
      ? { state: 'ok', misnamedKeys: scan.misnamedKeys }
      : {
          state: scan.misnamedKeys.length > 0 ? 'misnamed' : 'missing',
          misnamedKeys: scan.misnamedKeys,
        };
  }

  acquire(): AnthropicClientLease | null {
    return this.lease;
  }

  keyState(): AnthropicKeyInspection {
    return {
      state: this.keyInfo.state,
      misnamedKeys: [...this.keyInfo.misnamedKeys],
    };
  }

  reportCallFailure(): void {
    /* env rejimi: holat kuzatilmaydi (bugungi xulq) */
  }

  reportCallOutcome(): void {
    /* env rejimi: salomatlik kuzatilmaydi */
  }
}
