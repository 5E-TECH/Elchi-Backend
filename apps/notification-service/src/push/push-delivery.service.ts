import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  NotificationDeliveryStatus,
  NotificationPriority,
  OutboxService,
} from '@app/common';
import { Notification } from '../entities/notification.entity';
import { PushSubscription } from '../entities/push-subscription.entity';
import {
  PushPayload,
  PushSendResult,
  WebPushService,
} from './web-push.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import { pushSuppressedByPresence } from '../channels/resolve-channels';
import {
  quietWindowEnd,
  quietWindowFromContact,
} from '../preferences/quiet-hours';

/** Outbox hodisasi: notification-service o'z navbatiga yuboradi. */
export const PUSH_DELIVER_PATTERN = 'notification.push.deliver';
export const PUSH_OUTBOX_TARGET = 'NOTIFICATION';
/** Bitta outbox hodisasidagi bildirishnomalar soni (yetkazish partiyasi). */
export const PUSH_DELIVER_CHUNK = 100;
/**
 * (Jht84wGp TC6) Vaqtinchalik xato (5xx/429/tarmoq) bo'lsa jami urinishlar
 * soni. Har qayta urinish — YANGI outbox hodisasi `scheduledAt` bilan
 * (RMQ navbat TTL'iga tegilmaydi).
 */
export const PUSH_MAX_ATTEMPTS = 3;
const PUSH_RETRY_DELAYS_MS = [60_000, 5 * 60_000];
/** Gateway onlaynlik so'rovi chegarasi — javob bo'lmasa oflayn deb hisoblanadi. */
const PRESENCE_TIMEOUT_MS = 1_500;
/** (7Ec56EIw #4) Gateway'da onlaynlik patterni (BOG'LIQLIK — gateway kartasi). */
export const PRESENCE_CHECK_PATTERN = 'realtime.presence.check';

/** `delivery.push` qiymatlari. */
export type PushDeliveryState =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'no_subscription'
  | 'skipped';

export interface PushDeliverInput {
  notification_ids?: string[];
  /** Nechanchi urinish (1 dan). */
  attempt?: number;
  /** Tinch soat tekshiruvi allaqachon o'tgan (ertalabga surilgan hodisa). */
  quiet_checked?: boolean;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

const isQueued = (row: Notification) =>
  row.delivery?.push === NotificationDeliveryStatus.QUEUED;

/**
 * Push yetkazish (Jht84wGp). Dispatch faqat NAVBATGA qo'yadi (`enqueue`) va
 * javobini kutmaydi; yuborishni outbox → shu servisning `deliver` qiladi.
 *
 * Idempotent: faqat `delivery.push = 'queued'` qatorlar olinadi — outbox
 * qayta urinsa (timeout, restart) yuborilgan/yakunlangan qatorlar o'tkazib
 * yuboriladi, bitta hodisa uchun ikki push ketmaydi.
 */
@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
    private readonly webPush: WebPushService,
    private readonly outbox: OutboxService,
    private readonly smsDispatch: SmsDispatchService,
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: ConfigService,
    @Optional()
    @Inject('GATEWAY')
    private readonly gatewayClient?: ClientProxy,
  ) {}

  /**
   * Inbox qatorlari bilan BITTA tranzaksiyada navbatga qo'yadi (`manager`) —
   * dispatch rollback bo'lsa push ham ketmaydi.
   */
  async enqueue(
    manager: EntityManager,
    notificationIds: string[],
  ): Promise<void> {
    for (const ids of chunk(notificationIds, PUSH_DELIVER_CHUNK)) {
      await this.outbox.enqueue(
        PUSH_OUTBOX_TARGET,
        PUSH_DELIVER_PATTERN,
        { notification_ids: ids },
        { manager },
      );
    }
  }

  async deliver(input: PushDeliverInput) {
    const ids = (input?.notification_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    if (!ids.length) return { processed: 0 };

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let locked = false;
    const lockKey = `notification.push.deliver:${[...ids].sort().join(',')}`;
    try {
      const [state] = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      )) as Array<{ locked: boolean }>;
      locked = Boolean(state?.locked);
      if (!locked) throw new Error('Push yuborishni boshqa ishchi bajarmoqda');
      return await this.deliverLocked(ids, input ?? {});
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
          .catch(() => undefined);
      }
      await runner.release();
    }
  }

  private async deliverLocked(ids: string[], input: PushDeliverInput) {
    const attempt =
      Number.isInteger(input.attempt) && Number(input.attempt) > 0
        ? Number(input.attempt)
        : 1;
    const rows = await this.notifications.find({ where: { id: In(ids) } });
    let pending = rows.filter((row) => isQueued(row) && !row.isDeleted);
    if (!pending.length) return { processed: 0 };

    if (!this.webPush.enabled) {
      await this.patchDelivery(
        pending.map((row) => row.id),
        { push: 'failed', push_error: 'push_disabled' },
      );
      await this.flagEscalation(pending);
      return { processed: pending.length, sent: 0 };
    }

    // (7Ec56EIw #4) Onlayn (socket ulangan) + realtime so'ralgan — push emas.
    const online = await this.onlineSuppressed(pending);
    if (online.length) {
      await this.patchDelivery(
        online.map((row) => row.id),
        { push: 'skipped', push_reason: 'online' },
      );
      const skipped = new Set(online.map((row) => row.id));
      pending = pending.filter((row) => !skipped.has(row.id));
    }

    const recipientIds = [
      ...new Set(pending.map((row) => String(row.recipient_id))),
    ];
    const subs = recipientIds.length
      ? await this.subscriptions.find({
          where: { user_id: In(recipientIds) },
        })
      : [];
    const subsByUser = new Map<string, PushSubscription[]>();
    for (const sub of subs) {
      const key = String(sub.user_id);
      subsByUser.set(key, [...(subsByUser.get(key) ?? []), sub]);
    }

    // (mP1WGG1W #6) Tinch soat — critical bo'lmagan push TASHLANMAYDI,
    // ertalabga (oyna oxiriga) outbox `scheduledAt` bilan suriladi.
    const deferred = input.quiet_checked
      ? []
      : await this.deferForQuietHours(pending, subsByUser, attempt);
    if (deferred.length) {
      const moved = new Set(deferred);
      pending = pending.filter((row) => !moved.has(row.id));
    }
    if (!pending.length) {
      return {
        processed: rows.length,
        sent: 0,
        deferred: deferred.length,
        skipped_online: online.length,
      };
    }

    // Har bildirishnoma parallel; har biri o'z obunalariga partiyalab yuboradi.
    const settled = await Promise.allSettled(
      pending.map((row) =>
        this.webPush.sendToSubscriptions(
          subsByUser.get(String(row.recipient_id)) ?? [],
          this.toPayload(row),
        ),
      ),
    );

    const sentIds: string[] = [];
    const noSubIds: string[] = [];
    const failedByError = new Map<string, string[]>();
    const retryByError = new Map<string, string[]>();
    settled.forEach((outcome, index) => {
      const row = pending[index];
      const result: PushSendResult =
        outcome.status === 'fulfilled'
          ? outcome.value
          : {
              sent: 0,
              failed: 1,
              gone: 0,
              error:
                outcome.reason instanceof Error
                  ? outcome.reason.message
                  : 'unknown',
              retryable: true,
            };
      if (result.sent > 0) {
        sentIds.push(row.id);
      } else if (result.failed === 0) {
        // Obuna yo'q yoki hammasi 404/410 bo'lib o'chirildi.
        noSubIds.push(row.id);
      } else {
        const error = result.error ?? 'unknown';
        const target =
          result.retryable && attempt < PUSH_MAX_ATTEMPTS
            ? retryByError
            : failedByError;
        target.set(error, [...(target.get(error) ?? []), row.id]);
      }
    });

    await this.patchDelivery(sentIds, {
      push: 'sent',
      push_sent_at: new Date().toISOString(),
      push_error: null,
    });
    await this.patchDelivery(noSubIds, { push: 'no_subscription' });
    for (const [error, failedIds] of failedByError) {
      await this.patchDelivery(failedIds, {
        push: 'failed',
        push_error: error,
        push_attempts: attempt,
      });
    }
    let retried = 0;
    for (const [error, retryIds] of retryByError) {
      retried += retryIds.length;
      await this.scheduleRetry(retryIds, error, attempt);
    }
    // Yuborilgan va qayta urinishga qo'yilganlar — eskalatsiya belgisi yo'q.
    const settledOk = new Set([
      ...sentIds,
      ...[...retryByError.values()].flat(),
    ]);
    await this.flagEscalation(pending.filter((row) => !settledOk.has(row.id)));

    return {
      processed: pending.length,
      sent: sentIds.length,
      no_subscription: noSubIds.length,
      failed: pending.length - sentIds.length - noSubIds.length - retried,
      ...(retried ? { retry: retried } : {}),
      ...(deferred.length ? { deferred: deferred.length } : {}),
      ...(online.length ? { skipped_online: online.length } : {}),
    };
  }

  /**
   * (Jht84wGp TC6) Vaqtinchalik xato — qator O'CHMAYDI (`last_error`
   * web-push.service'da), `delivery.push` yana `queued`, keyingi urinish —
   * yangi outbox hodisasi `scheduledAt` bilan. Holat va hodisa BITTA
   * tranzaksiyada (biri yozilib, ikkinchisi yo'qolmasin).
   */
  private async scheduleRetry(ids: string[], error: string, attempt: number) {
    const delay =
      PUSH_RETRY_DELAYS_MS[Math.min(attempt, PUSH_RETRY_DELAYS_MS.length) - 1];
    const scheduledAt = new Date(Date.now() + delay);
    await this.notifications.manager.transaction(async (manager) => {
      await this.patchDelivery(
        ids,
        {
          push: 'queued',
          push_error: error,
          push_attempts: attempt,
          push_retry_at: scheduledAt.toISOString(),
        },
        manager,
      );
      for (const part of chunk(ids, PUSH_DELIVER_CHUNK)) {
        await this.outbox.enqueue(
          PUSH_OUTBOX_TARGET,
          PUSH_DELIVER_PATTERN,
          { notification_ids: part, attempt: attempt + 1, quiet_checked: true },
          { manager, scheduledAt },
        );
      }
    });
  }

  /**
   * Tinch soatga tushgan (critical bo'lmagan, obunasi bor) qatorlarni
   * oyna oxiriga suradi. Tinch soatlar — identity `user.settings`
   * (`notifications.quiet_hours`); identity javob bermasa — hozir yuboriladi
   * (fail-open: tunda push noqulay, lekin xabar yo'qolmaydi).
   */
  private async deferForQuietHours(
    rows: Notification[],
    subsByUser: Map<string, PushSubscription[]>,
    attempt: number,
  ): Promise<string[]> {
    const candidates = rows.filter(
      (row) =>
        row.priority !== NotificationPriority.CRITICAL &&
        (subsByUser.get(String(row.recipient_id))?.length ?? 0) > 0,
    );
    if (!candidates.length) return [];

    let contacts: Map<string, unknown>;
    try {
      contacts = await this.smsDispatch.contacts([
        ...new Set(candidates.map((row) => String(row.recipient_id))),
      ]);
    } catch (error) {
      this.logger.warn(
        `Tinch soatlarni o'qib bo'lmadi (identity) — push hozir yuboriladi: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return [];
    }

    const now = new Date();
    const byEnd = new Map<number, string[]>();
    for (const row of candidates) {
      const window = quietWindowFromContact(
        contacts.get(String(row.recipient_id)),
      );
      const end = window ? quietWindowEnd(now, window) : null;
      if (!end) continue;
      byEnd.set(end.getTime(), [...(byEnd.get(end.getTime()) ?? []), row.id]);
    }

    const deferred: string[] = [];
    for (const [endMs, ids] of byEnd) {
      const scheduledAt = new Date(endMs);
      await this.notifications.manager.transaction(async (manager) => {
        await this.patchDelivery(
          ids,
          {
            push: 'queued',
            push_reason: 'quiet_hours',
            push_deferred_until: scheduledAt.toISOString(),
          },
          manager,
        );
        for (const part of chunk(ids, PUSH_DELIVER_CHUNK)) {
          await this.outbox.enqueue(
            PUSH_OUTBOX_TARGET,
            PUSH_DELIVER_PATTERN,
            { notification_ids: part, attempt, quiet_checked: true },
            { manager, scheduledAt },
          );
        }
      });
      deferred.push(...ids);
    }
    return deferred;
  }

  /**
   * (7Ec56EIw #4) Onlayn foydalanuvchiga push yuborilmaydi (REALTIME ham
   * so'ralgan bo'lsa). Onlaynlik faqat gateway'da (`realtime.gateway.ts`
   * `online` Map) — `realtime.presence.check` RMQ patterni gateway kartasida;
   * u deploy qilinmaguncha NOTIF_PUSH_PRESENCE_CHECK=false (sukut) — tekshiruv
   * o'chiq, push hammaga ketadi. Javob bo'lmasa — oflayn (push ketadi).
   */
  private async onlineSuppressed(
    rows: Notification[],
  ): Promise<Notification[]> {
    if (!this.presenceCheckEnabled || !this.gatewayClient) return [];
    const withRealtime = rows.filter((row) =>
      pushSuppressedByPresence(row.channels, true),
    );
    if (!withRealtime.length) return [];
    const userIds = [
      ...new Set(withRealtime.map((row) => String(row.recipient_id))),
    ];
    try {
      const res = await lastValueFrom(
        this.gatewayClient
          .send<unknown>({ cmd: PRESENCE_CHECK_PATTERN }, { user_ids: userIds })
          .pipe(timeout(PRESENCE_TIMEOUT_MS)),
        { defaultValue: null },
      );
      const data = (res as { data?: unknown })?.data ?? res;
      const list = Array.isArray(data)
        ? data
        : ((data as { online?: unknown })?.online ?? []);
      const online = new Set(
        (Array.isArray(list) ? list : []).map((id) => String(id)),
      );
      return withRealtime.filter((row) =>
        pushSuppressedByPresence(
          row.channels,
          online.has(String(row.recipient_id)),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Onlaynlikni tekshirib bo'lmadi — push yuboriladi: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return [];
    }
  }

  private get presenceCheckEnabled(): boolean {
    const raw = this.config?.get<unknown>('NOTIF_PUSH_PRESENCE_CHECK');
    return (
      raw === true ||
      (typeof raw === 'string' && raw.trim().toLowerCase() === 'true')
    );
  }

  /** `delivery` JSONB'ga birlashtiradi (logga emas, DB'ga). */
  private async patchDelivery(
    ids: string[],
    patch: Record<string, unknown>,
    manager?: EntityManager,
  ) {
    if (!ids.length) return;
    const repo = manager
      ? manager.getRepository(Notification)
      : this.notifications;
    await repo
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds(ids)
      .execute();
  }

  /**
   * CRITICAL bildirishnoma push bilan yetmasa — faqat BELGI
   * (`delivery.escalation_pending = true`). SMS'ning o'zi bu yerda
   * YUBORILMAYDI (Jht84wGp TUZATISH): dispatch paytida rejalashtirilgan
   * `notification.escalate` hodisasi (NOTIF_ESCALATION_MINUTES dan keyin)
   * qator o'qilmaganini tekshiradi va ATIGI BIR MARTA SMS'ga tushiradi
   * (notification-escalation.service.ts). Avval push yiqilishi bilan DARHOL
   * SMS ketardi — foydalanuvchi in-app xabarni bir daqiqada o'qisa ham pul.
   */
  private async flagEscalation(rows: Notification[]) {
    const ids = rows
      .filter((row) => row.priority === NotificationPriority.CRITICAL)
      .map((row) => row.id);
    if (!ids.length) return;
    const result = await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () =>
          `COALESCE("delivery", '{}'::jsonb) || '{"escalation_pending": true}'::jsonb`,
      })
      .whereInIds(ids)
      .andWhere(`("delivery"->>'escalated_at') IS NULL`)
      .andWhere(
        `COALESCE(("delivery"->>'escalation_pending')::boolean, false) = false`,
      )
      .execute();
    if (result.affected) {
      this.logger.warn(
        `CRITICAL push yetmadi — ${result.affected} ta bildirishnoma SMS eskalatsiyasini kutmoqda (notification.escalate).`,
      );
    }
  }

  private toPayload(row: Notification): PushPayload {
    return {
      id: String(row.id),
      title: row.title,
      body: row.body,
      link: row.link,
      type: row.type,
      priority: row.priority,
      tag: row.group_key ?? `notification-${row.id}`,
    };
  }
}
