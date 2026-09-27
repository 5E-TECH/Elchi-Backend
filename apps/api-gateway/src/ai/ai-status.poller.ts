import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import type { AiHealthState, AiStatusResponse } from '@app/common';

/** ai-service holati shu oraliqda so'raladi. */
export const AI_STATUS_POLL_INTERVAL_MS = 30_000;
/** Bitta `ai.status` so'rovining shifti (C7). */
export const AI_STATUS_POLL_TIMEOUT_MS = 1_500;

/**
 * AI holati keshi — gateway `/health` (`ai` maydoni) va
 * `GET /orders/ai-availability` uchun (bVeyEuIR, HD5zOyBp #9; PLAN C8).
 *
 * ⚠️ NEGA KESH. `/health` liveness — tez va RMQ'siz bo'lishi SHART: u har
 * healthcheck'da chaqiriladi va ai-service sekinlashsa gateway'ning o'zi
 * "kasal" ko'rinmasligi kerak. Shu bois `getState()` SINXRON va faqat
 * keshni o'qiydi; `ai.status` fonda har 30s da (timeout 1.5s) so'raladi.
 * Taymer `unref()` — jarayonni tirik ushlab turmaydi.
 *
 * Holat:
 *  - `disabled` — AI_ORDER_ENABLED o'chiq, yoki ai-service'da kalit yo'q /
 *    noto'g'ri nomlangan (`key_state !== 'ok'`) yoki `enabled: false`;
 *  - `cap_exceeded` — global kunlik shift urilgan ("AI limiti", 'o'chiq' EMAS);
 *  - `enabled` — kalit bor, shift ochiq;
 *  - `unknown` — birinchi so'rovdan oldin, ai-service javob bermasa
 *    (xato/timeout), javob shakli buzuq bo'lsa yoki shift holatini ai-service
 *    o'zi o'qiy olmasa (`cap.state: 'unknown'` — u holda AI fail-closed).
 *
 * ⚠️ Qayta urinish (retry) YO'Q — keyingi so'rov 30s dan keyin.
 */
@Injectable()
export class AiStatusPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiStatusPoller.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: AiStatusResponse | null = null;
  private inFlight = false;
  private failureLogged = false;

  constructor(
    @Optional() @Inject('AI') private readonly aiClient?: ClientProxy,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.aiClient || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, AI_STATUS_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Keshdan (RMQ KUTILMAYDI) joriy AI holati. */
  getState(): AiHealthState {
    if (!this.isFlagEnabled()) return 'disabled';
    const status = this.status;
    if (!status) return 'unknown';
    if (status.enabled !== true || status.key_state !== 'ok') {
      return 'disabled';
    }
    const capState = status.cap?.state;
    if (capState === 'exceeded') return 'cap_exceeded';
    if (capState === 'ok' || capState === 'warn') return 'enabled';
    return 'unknown';
  }

  /**
   * Bitta `ai.status` so'rovi. HECH QACHON throw qilmaydi: xato yoki timeout
   * keshni `unknown` holatiga o'tkazadi. Oldingi so'rov tugamagan bo'lsa
   * yangisi yuborilmaydi.
   */
  async poll(): Promise<void> {
    if (!this.aiClient || this.inFlight) return;
    this.inFlight = true;
    try {
      const response: unknown = await firstValueFrom(
        this.aiClient
          .send({ cmd: 'ai.status' }, {})
          .pipe(timeout(AI_STATUS_POLL_TIMEOUT_MS)),
      );
      const status = this.parseStatus(response);
      this.status = status;
      if (status) {
        this.failureLogged = false;
      } else {
        this.logFailureOnce('javob shakli buzuq');
      }
    } catch (error: unknown) {
      this.status = null;
      this.logFailureOnce(
        error instanceof Error ? error.name || 'Error' : typeof error,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private isFlagEnabled(): boolean {
    const raw: unknown = this.config?.get<unknown>('AI_ORDER_ENABLED');
    if (typeof raw === 'boolean') return raw;
    return (
      typeof raw === 'string' &&
      ['true', '1', 'yes'].includes(raw.trim().toLowerCase())
    );
  }

  /** `AiStatusResponse` (yoki `{data: AiStatusResponse}`) — aks holda null. */
  private parseStatus(response: unknown): AiStatusResponse | null {
    const looksLikeStatus = (value: unknown): value is AiStatusResponse =>
      !!value &&
      typeof value === 'object' &&
      typeof (value as { key_state?: unknown }).key_state === 'string' &&
      typeof (value as { enabled?: unknown }).enabled === 'boolean';
    if (looksLikeStatus(response)) return response;
    const wrapped = (response as { data?: unknown } | null)?.data;
    return looksLikeStatus(wrapped) ? wrapped : null;
  }

  /** Har 30s da log to'ldirmaslik uchun — faqat holat buzilganda bir marta. */
  private logFailureOnce(detail: string): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    this.logger.warn(`ai.status olinmadi (${detail}) — AI holati: unknown`);
  }
}
