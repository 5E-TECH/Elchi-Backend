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
import { OUTBOX_OPTIONS, OUTBOX_TARGETS } from './tokens';
import type { OutboxOptions } from './tokens';
import { captureException } from '../sentry/sentry.helper';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly clients = new Map<string, ClientProxy>();
  private intervalHandle?: NodeJS.Timeout;
  private failedAlertHandle?: NodeJS.Timeout;
  private isProcessing = false;
  private lastFailedCount = 0;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly publishTimeoutMs: number;
  private readonly failedAlertIntervalMs: number;

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
  }

  async onModuleInit(): Promise<void> {
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
      const client = this.clients.get(event.target);
      if (!client) {
        await this.outbox.markFailed(
          event.id,
          `No client registered for target '${event.target}'`,
          60_000,
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
        const backoffMs = Math.min(2 ** event.attempts * 1000, 60_000);
        await this.outbox.markFailed(event.id, errorMsg, backoffMs);
        this.logger.warn(
          `Outbox event ${event.id} (${event.target}/${event.pattern}) failed (attempt ${event.attempts + 1}): ${errorMsg}, retry in ${backoffMs}ms`,
        );
      }
    }
  }
}
