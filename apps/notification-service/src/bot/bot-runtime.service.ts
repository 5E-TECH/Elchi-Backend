import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { Interval } from '@nestjs/schedule';
import { rmqSend } from '@app/common';
import {
  TELEGRAM_ALLOWED_UPDATES,
  resolveBotConfig,
  type BotRuntimeConfig,
} from './bot-config';
import { botLinkedUsers, botTokenHealthy } from './bot-metrics';
import { BotRouterService } from './bot-router.service';
import { BotSessionService } from './bot-session.service';
import { BotTransportService, TelegramApiError } from './bot-transport.service';

/** Polling backoff: 3s → 6 → 12 → 24 → 48 → 60s (shift). */
export const POLL_BACKOFF_START_MS = 3_000;
export const POLL_BACKOFF_MAX_MS = 60_000;

export function pollBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(
    POLL_BACKOFF_START_MS * 2 ** (failures - 1),
    POLL_BACKOFF_MAX_MS,
  );
}

export interface BotHealth {
  /** Token sozlanganmi (placeholder emas). */
  enabled: boolean;
  mode: BotRuntimeConfig['mode'];
  /** getMe natijasi: true/false; tekshirilmagan — null. */
  healthy: boolean | null;
  username: string | null;
  reason: string;
}

/**
 * (Mvx0h1Fv #5 / bOMYoOtV #5 / 9HIaV80X #5) Bot hayot sikli:
 *  - startda `getMe`: 401/404 → bot UMUMAN ishga tushmaydi (webhook update'lar
 *    rad, polling yo'q), xato BIR marta loglanadi, `bot_token_healthy = 0`,
 *    readiness qizaradi (`notification.health` → `degraded`);
 *  - webhook rejimida getUpdates HECH QACHON chaqirilmaydi;
 *  - polling (zaxira, faqat leader): webhook o'rnatilgan bo'lsa ishga
 *    tushmaydi; xatoda 3s→60s eksponensial backoff, 401/404 da TO'XTAYDI;
 *    offset `telegram_sessions` da (restartdan keyin davom etadi).
 */
@Injectable()
export class BotRuntimeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BotRuntimeService.name);
  readonly config: BotRuntimeConfig;
  private healthy: boolean | null = null;
  private username: string | null = null;
  private stopReason: string | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private tokenRejected = false;
  /** Birinchi getMe — webhook hodisalari shu tugashini kutadi. */
  private bootCheck: Promise<boolean> | null = null;
  private offset = 0;
  /** Sinovlarda almashtiriladi. */
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout = (fn, ms) =>
    setTimeout(fn, ms);

  constructor(
    configService: ConfigService,
    private readonly transport: BotTransportService,
    private readonly router: BotRouterService,
    private readonly sessions: BotSessionService,
    @Inject('IDENTITY') private readonly identity: ClientProxy,
  ) {
    this.config = resolveBotConfig((key) => configService.get(key));
    if (String(configService.get('ORDER_BOT_TOKEN') ?? '').trim()) {
      this.logger.warn(
        'ORDER_BOT_TOKEN endi ishlatilmaydi (ZlpXb4Wh: bitta bot, bitta token) — TELEGRAM_BOT_TOKEN ishlatiladi; ORDER_BOT_TOKEN ni .env dan olib tashlang',
      );
    }
  }

  health(): BotHealth {
    return {
      enabled: Boolean(this.config.token),
      mode: this.stopReason ? 'off' : this.config.mode,
      healthy: this.healthy,
      username: this.username,
      reason: this.stopReason ?? this.config.reason,
    };
  }

  /** Readiness: token bor-u getMe o'tmagan — qizil. Token yo'q (off) — ta'sir yo'q. */
  isDegraded(): boolean {
    return Boolean(this.config.token) && this.healthy !== true;
  }

  /**
   * Webhook update'lari faqat webhook rejimida va token RAD ETILMAGAN bo'lsa
   * qabul qilinadi. getMe vaqtinchalik (tarmoq) xatosida update'lar
   * tashlanmaydi — javoblar outbox orqali qayta urinadi; readiness esa qizil.
   */
  acceptsWebhook(): boolean {
    return (
      this.config.mode === 'webhook' &&
      !this.tokenRejected &&
      this.healthy !== null
    );
  }

  /**
   * Birinchi token tekshiruvi tugashini kutadi (deploy paytida RMQ
   * iste'molchisi getMe dan oldin update olsa ham u tashlanmaydi).
   */
  ready(): Promise<boolean> {
    if (!this.config.token) return Promise.resolve(false);
    this.bootCheck ??= this.checkToken();
    return this.bootCheck;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(
      `Telegram bot: rejim=${this.config.mode} (${this.config.reason}), slug=${this.config.slug}`,
    );
    if (!this.config.token) {
      botTokenHealthy.set({ bot: this.config.slug }, 0);
      return;
    }
    await this.ready();
    if (this.healthy && this.config.mode === 'polling') {
      await this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * getMe. Holat o'zgarganda BIR marta log. 401/404 — token buzuq: polling
   * to'xtaydi, webhook update'lari rad. Tarmoq xatosi — `healthy=false`,
   * 5 daqiqada qayta tekshiriladi.
   */
  @Interval('telegram-bot-token-check', 5 * 60_000)
  async checkToken(): Promise<boolean> {
    // Token rad etilgan (401/404) — qayta urinilmaydi, faqat restart (yangi token).
    if (!this.config.token || this.tokenRejected) return false;
    const before = this.healthy;
    try {
      const me = await this.transport.getMe();
      this.healthy = true;
      this.username = me?.username ?? null;
      if (before !== true) {
        this.logger.log(`Telegram bot tokeni sog' (@${this.username ?? '?'})`);
      }
    } catch (error) {
      this.healthy = false;
      const permanent =
        error instanceof TelegramApiError && error.kind === 'unauthorized';
      if (permanent) {
        this.tokenRejected = true;
        this.stopReason = `getMe ${error.status}: token buzuq — bot ishga tushmadi`;
        this.onModuleDestroy();
      }
      if (before !== false) {
        this.logger.error(
          `Telegram bot tokeni tekshiruvdan o'tmadi: ${this.transport.describe(error)}${permanent ? " — bot ishga tushmaydi (polling/webhook o'chiq), readiness qizil" : ''}`,
        );
      }
    }
    botTokenHealthy.set({ bot: this.config.slug }, this.healthy ? 1 : 0);
    return this.healthy === true;
  }

  /** (9HIaV80X #6) `bot_linked_users{role}` — identity'dan, 5 daqiqada. */
  @Interval('telegram-bot-linked-users', 5 * 60_000)
  async refreshLinkedUsers(): Promise<void> {
    try {
      const response = await rmqSend<{
        data?: Array<{ role: string; count: number }>;
      }>(
        this.identity,
        { cmd: 'identity.telegram.linked_counts' },
        {},
        { timeoutMs: 5_000, retries: 0 },
      );
      botLinkedUsers.reset();
      for (const row of response?.data ?? []) {
        botLinkedUsers.set({ role: String(row.role) }, Number(row.count) || 0);
      }
    } catch (error) {
      this.logger.debug(
        `bot_linked_users yangilanmadi: ${this.transport.describe(error)}`,
      );
    }
  }

  private async startPolling(): Promise<void> {
    try {
      const info = await this.transport.getWebhookInfo();
      if (info?.url) {
        this.stopReason =
          "webhook o'rnatilgan — polling ishga tushmaydi (ikki transport yonma-yon ishlamaydi)";
        this.logger.warn(this.stopReason);
        return;
      }
    } catch (error) {
      this.logger.warn(
        `getWebhookInfo: ${this.transport.describe(error)} — polling baribir boshlanadi`,
      );
    }
    this.offset = await this.sessions
      .getPollOffset(this.config.slug)
      .catch(() => 0);
    this.running = true;
    this.logger.log('Telegram bot polling (zaxira, leader) boshlandi');
    void this.pollOnce();
  }

  /** Bitta getUpdates sikli; keyingisini o'zi rejalashtiradi. */
  async pollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const updates = await this.transport.getUpdates(
        this.offset,
        TELEGRAM_ALLOWED_UPDATES,
      );
      this.failures = 0;
      if (!this.running) return;
      if (updates.length) {
        for (const update of updates) {
          this.offset = update.update_id + 1;
          // Ishlov kutilmaydi: per-chat navbat router ichida.
          void this.router.dispatch(this.config.slug, update);
        }
        await this.sessions
          .setPollOffset(this.config.slug, this.offset)
          .catch((error: unknown) =>
            this.logger.warn(
              `polling offset saqlanmadi: ${this.transport.describe(error)}`,
            ),
          );
      }
      this.next(200);
    } catch (error) {
      if (error instanceof TelegramApiError && error.kind === 'unauthorized') {
        this.healthy = false;
        this.tokenRejected = true;
        botTokenHealthy.set({ bot: this.config.slug }, 0);
        this.stopReason = `getUpdates ${error.status}: token buzuq — polling to'xtadi`;
        this.running = false;
        this.logger.error(this.stopReason);
        return;
      }
      this.failures += 1;
      const delay = pollBackoffMs(this.failures);
      if (this.failures === 1 || delay === POLL_BACKOFF_MAX_MS) {
        this.logger.error(
          `getUpdates xato (${this.failures}-marta, keyingisi ${delay / 1000}s dan keyin): ${this.transport.describe(error)}${error instanceof TelegramApiError && error.status === 409 ? " — 409 Conflict: boshqa nusxa polling qilyapti yoki webhook o'rnatilgan" : ''}`,
        );
      }
      this.next(delay);
    }
  }

  private next(delayMs: number): void {
    if (!this.running) return;
    this.timer = this.schedule(() => void this.pollOnce(), delayMs);
  }
}
