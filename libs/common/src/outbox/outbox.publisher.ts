import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { OutboxService } from './outbox.service';
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_PERSISTENT_OUTBOX_PATTERNS,
  OUTBOX_OPTIONS,
  OUTBOX_TARGETS,
  isPersistentOutboxPattern,
} from './tokens';
import type { OutboxOptions } from './tokens';
import { captureException } from '../sentry/sentry.helper';

/** Qayta urinish oralig'ining yuqori chegarasi (ms). */
const OUTBOX_MAX_BACKOFF_MS = 60_000;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly clients = new Map<string, ClientProxy>();
  private intervalHandle?: NodeJS.Timeout;
  private failedAlertHandle?: NodeJS.Timeout;
  private isProcessing = false;
  private lastFailedCount = 0;
  private lastStuckCount = 0;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly publishTimeoutMs: number;
  private readonly failedAlertIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly persistentPatterns: readonly string[];
  private readonly stuckAlertAttempts: number;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly outbox: OutboxService,
    @Inject(OUTBOX_TARGETS) private readonly targets: string[],
    @Optional() @Inject(OUTBOX_OPTIONS) options?: OutboxOptions,
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.batchSize = options?.batchSize ?? 50;
    this.publishTimeoutMs = options?.publishTimeoutMs ?? 5000;
    this.failedAlertIntervalMs = options?.failedAlertIntervalMs ?? 60_000;
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
    this.persistentPatterns =
      options?.persistentPatterns ?? DEFAULT_PERSISTENT_OUTBOX_PATTERNS;
    this.stuckAlertAttempts =
      options?.stuckAlertAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
  }

  /**
   * Shu hodisa uchun `failed` chegarasi. Pul hodisasi (doimiy pattern) —
   * `Infinity`: maqsad servis qancha ishlamasa ham hodisa tashlab
   * yuborilmaydi, 60 s lik chegarada qayta uriniladi (audit M8).
   */
  private maxAttemptsFor(pattern: string): number {
    return isPersistentOutboxPattern(pattern, this.persistentPatterns)
      ? Number.POSITIVE_INFINITY
      : this.maxAttempts;
  }

  onModuleInit(): void {
    for (const target of this.targets) {
      try {
        const client = this.moduleRef.get<ClientProxy>(target, {
          strict: false,
        });
        if (client) this.clients.set(target, client);
      } catch {
        this.logger.warn(
          `Outbox target '${target}' not registered in this module`,
        );
      }
    }

    this.intervalHandle = setInterval(
      () => this.scheduleTick(),
      this.pollIntervalMs,
    );
    this.failedAlertHandle = setInterval(
      () => void this.checkFailedEvents(),
      this.failedAlertIntervalMs,
    );
    this.logger.log(
      `Outbox publisher started: targets=[${this.targets.join(',')}], interval=${this.pollIntervalMs}ms, failedAlert=${this.failedAlertIntervalMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.failedAlertHandle) clearInterval(this.failedAlertHandle);
  }

  /**
   * Surface terminal FAILED (poison) outbox events. They are never retried and
   * are invisible to getDuePending, so without this a stuck money/state event
   * would sit silently forever. Logs at error level every interval while any
   * exist, and raises a Sentry alert only when the count CHANGES so Sentry is
   * not flooded. (Audit resilience/observability P1.)
   */
  private async checkFailedEvents(): Promise<void> {
    try {
      const failed = await this.outbox.countFailed();
      if (failed > 0) {
        const message = `Outbox has ${failed} FAILED (poison) event(s) — money/state delivery is stuck; inspect outbox_events WHERE status='failed'`;
        this.logger.error(message);
        if (failed !== this.lastFailedCount) {
          captureException(new Error(message), { outbox_failed_count: failed });
        }
      }
      this.lastFailedCount = failed;
    } catch (error) {
      this.logger.error('Outbox failed-events check failed', error as Error);
    }

    // Doimiy (pul) hodisalar endi `failed` bo'lmaydi — ular uzoq yetkazilmasa
    // shu yerda ko'rinadi (audit M8). Sentry — faqat soni o'zgarganda.
    try {
      const stuck = await this.outbox.countStuckPending(
        this.stuckAlertAttempts,
      );
      if (stuck > 0) {
        const message = `Outbox has ${stuck} STUCK pending event(s) (>= ${this.stuckAlertAttempts} failed attempts, still retrying every ${OUTBOX_MAX_BACKOFF_MS / 1000}s) — target service unreachable or rejecting; inspect outbox_events WHERE status='pending' AND attempts >= ${this.stuckAlertAttempts}`;
        this.logger.error(message);
        if (stuck !== this.lastStuckCount) {
          captureException(new Error(message), { outbox_stuck_count: stuck });
        }
      }
      this.lastStuckCount = stuck;
    } catch (error) {
      this.logger.error('Outbox stuck-events check failed', error as Error);
    }
  }

  private scheduleTick(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.tick()
      .catch((error) => this.logger.error('Outbox tick failed', error as Error))
      .finally(() => {
        this.isProcessing = false;
      });
  }

  private async tick(): Promise<void> {
    const events = await this.outbox.getDuePending(this.batchSize);
    if (events.length === 0) return;

    for (const event of events) {
      const maxAttempts = this.maxAttemptsFor(event.pattern);
      const client = this.clients.get(event.target);
      if (!client) {
        await this.outbox.markFailed(
          event.id,
          `No client registered for target '${event.target}'`,
          OUTBOX_MAX_BACKOFF_MS,
          maxAttempts,
        );
        continue;
      }

      try {
        await firstValueFrom(
          client
            .send({ cmd: event.pattern }, event.payload)
            .pipe(timeout(this.publishTimeoutMs)),
        );
        await this.outbox.markPublished(event.id);
      } catch (error) {
        const errorMsg = (error as Error)?.message ?? String(error);
        const backoffMs = Math.min(
          2 ** event.attempts * 1000,
          OUTBOX_MAX_BACKOFF_MS,
        );
        await this.outbox.markFailed(
          event.id,
          errorMsg,
          backoffMs,
          maxAttempts,
        );
        this.logger.warn(
          `Outbox event ${event.id} (${event.target}/${event.pattern}) failed (attempt ${event.attempts + 1}): ${errorMsg}, retry in ${backoffMs}ms`,
        );
      }
    }
  }
}
