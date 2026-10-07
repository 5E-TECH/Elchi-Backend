import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { NotificationPriority, OutboxService } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { PushSubscription } from '../entities/push-subscription.entity';
import {
  PushPayload,
  PushSendResult,
  WebPushService,
} from './web-push.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';

/** Outbox hodisasi: notification-service o'z navbatiga yuboradi. */
export const PUSH_DELIVER_PATTERN = 'notification.push.deliver';
export const PUSH_OUTBOX_TARGET = 'NOTIFICATION';
/** Bitta outbox hodisasidagi bildirishnomalar soni (yetkazish partiyasi). */
export const PUSH_DELIVER_CHUNK = 100;

/** `delivery.push` qiymatlari. */
export type PushDeliveryState =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'no_subscription';

export interface PushDeliverInput {
  notification_ids?: string[];
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * Push yetkazish (Jht84wGp). Dispatch faqat NAVBATGA qo'yadi (`enqueue`) va
 * javobini kutmaydi; yuborishni outbox → shu servisning `deliver` qiladi.
 *
 * Idempotent: outbox qayta urinsa (timeout, restart) `delivery.push = 'sent'`
 * bo'lganlar o'tkazib yuboriladi — bitta hodisa uchun ikki push ketmaydi.
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

    const rows = await this.notifications.find({ where: { id: In(ids) } });
    const pending = rows.filter((row) => row.delivery?.push !== 'sent');
    if (!pending.length) return { processed: 0 };

    if (!this.webPush.enabled) {
      await this.patchDelivery(
        pending.map((row) => row.id),
        { push: 'failed', push_error: 'push_disabled' },
      );
      await this.flagEscalation(pending);
      return { processed: pending.length, sent: 0 };
    }

    const recipientIds = [
      ...new Set(pending.map((row) => String(row.recipient_id))),
    ];
    const subs = await this.subscriptions.find({
      where: { user_id: In(recipientIds) },
    });
    const subsByUser = new Map<string, PushSubscription[]>();
    for (const sub of subs) {
      const key = String(sub.user_id);
      subsByUser.set(key, [...(subsByUser.get(key) ?? []), sub]);
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
            };
      if (result.sent > 0) {
        sentIds.push(row.id);
      } else if (result.failed === 0) {
        // Obuna yo'q yoki hammasi 404/410 bo'lib o'chirildi.
        noSubIds.push(row.id);
      } else {
        const error = result.error ?? 'unknown';
        failedByError.set(error, [...(failedByError.get(error) ?? []), row.id]);
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
      });
    }
    await this.flagEscalation(
      pending.filter((row) => !sentIds.includes(row.id)),
    );

    return {
      processed: pending.length,
      sent: sentIds.length,
      no_subscription: noSubIds.length,
      failed: pending.length - sentIds.length - noSubIds.length,
    };
  }

  /** `delivery` JSONB'ga birlashtiradi (logga emas, DB'ga). */
  private async patchDelivery(ids: string[], patch: Record<string, unknown>) {
    if (!ids.length) return;
    await this.notifications
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
   * CRITICAL bildirishnoma push bilan yetmasa — SMS'ga eskalatsiya BELGISI.
   *
   * Avval `delivery.escalation_pending = true` belgisi, keyin SmsDispatchService
   * `escalated_at` ni atomik qo'yib SMS navbatga qo'yadi. ATIGI BIR MARTA:
   * `escalated_at` bo'sh qatorlargagina (UPDATE ... WHERE) va SMS
   * `client_message_id = esc-<id>` UNIQUE — qayta urinish ikkinchi SMS yaratmaydi.
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
        `CRITICAL push yetmadi — ${result.affected} ta bildirishnoma SMS eskalatsiyasiga belgilandi.`,
      );
    }
    await this.smsDispatch.escalate(ids);
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
