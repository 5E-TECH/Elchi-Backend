import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import {
  NotificationChannel,
  NotificationPriority,
  OutboxService,
} from '@app/common';
import { Notification } from '../entities/notification.entity';
import { SmsConfigService } from '../sms/sms-config.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import { SmsBlockedError } from '../sms/sms-gate.service';
import { SmsDuplicateError } from '../sms/sms-outbox.service';

/** Outbox hodisasi: N daqiqadan keyin notification-service o'ziga yuboradi. */
export const ESCALATE_PATTERN = 'notification.escalate';
export const ESCALATE_OUTBOX_TARGET = 'NOTIFICATION';
const ESCALATE_CHUNK = 100;
const DEFAULT_ESCALATION_MINUTES = 10;

export interface EscalateInput {
  notification_ids?: unknown[];
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * POG'ONALI ESKALATSIYA (7Ec56EIw #5/#6, Jht84wGp #8): `priority=critical`
 * xabar N daqiqada (NOTIF_ESCALATION_MINUTES, sukut 10; 0 — o'chiq)
 * O'QILMASA va push yetmagan bo'lsa (`delivery.push` ≠ `sent`: failed /
 * no_subscription / no_provider / so'ralmagan) — SMS.
 *
 * ⚠️ Kechiktirish FAQAT outbox `scheduledAt` orqali — RMQ navbat
 * argumentlariga (RMQ_RPC_TTL_MS, x-message-ttl) TEGILMAYDI.
 *
 * ⚠️ ATIGI BIR MARTA (pul): handler `delivery.escalated_at` bo'sh qatorlarni
 * oladi, `SmsDispatchService.escalate` esa `escalated_at` ni ATOMIK
 * (`UPDATE ... WHERE escalated_at IS NULL RETURNING`) qo'yib SMS'ni navbatga
 * qo'yadi; SMS `client_message_id = esc-<id>` UNIQUE. Hodisa ikki marta
 * kelsa (ikki nusxa / outbox qayta urinishi) ikkinchisi hech narsa qilmaydi.
 */
@Injectable()
export class NotificationEscalationService {
  private readonly logger = new Logger(NotificationEscalationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly smsDispatch: SmsDispatchService,
    private readonly smsConfig: SmsConfigService,
  ) {}

  /** N daqiqa; 0 yoki manfiy — eskalatsiya o'chiq. */
  get delayMinutes(): number {
    const raw = this.config.get<string | number>('NOTIF_ESCALATION_MINUTES');
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_ESCALATION_MINUTES;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /**
   * Dispatch uchun: eskalatsiya rejalashtiriladimi va qachon. SMS o'zi
   * so'ralgan bo'lsa — kerak emas (SMS allaqachon navbatda / imkoniyati yo'q).
   */
  dueAt(
    priority: string | null | undefined,
    channels: readonly string[],
    now = new Date(),
  ): Date | null {
    if (priority !== NotificationPriority.CRITICAL) return null;
    if (channels.includes(NotificationChannel.SMS)) return null;
    const minutes = this.delayMinutes;
    if (!minutes) return null;
    return new Date(now.getTime() + minutes * 60_000);
  }

  /**
   * Dispatch tranzaksiyasi ICHIDA (`manager`) — dispatch rollback bo'lsa
   * eskalatsiya hodisasi ham qolmaydi.
   */
  async schedule(
    manager: EntityManager,
    notificationIds: string[],
    dueAt: Date,
  ): Promise<void> {
    for (const ids of chunk(notificationIds, ESCALATE_CHUNK)) {
      await this.outbox.enqueue(
        ESCALATE_OUTBOX_TARGET,
        ESCALATE_PATTERN,
        { notification_ids: ids },
        { manager, scheduledAt: dueAt },
      );
    }
  }

  /** Outbox iste'molchisi (`notification.escalate`). */
  async handle(input: EscalateInput) {
    const ids = [
      ...new Set(
        (Array.isArray(input?.notification_ids) ? input.notification_ids : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number'
              ? String(id).trim()
              : '',
          )
          .filter((id) => /^\d+$/.test(id)),
      ),
    ];
    if (!ids.length) return { checked: 0, escalated: 0 };

    const rows = await this.notifications.find({ where: { id: In(ids) } });
    const due = rows.filter(
      (row) =>
        row.priority === NotificationPriority.CRITICAL &&
        !row.isDeleted &&
        // O'qilgan xabar eskalatsiya qilinmaydi (TC10).
        !row.is_read &&
        // Idempotentlik (TC11): allaqachon eskalatsiya qilingan — o'tkazib yuboriladi.
        !row.delivery?.escalated_at &&
        // Push yetgan bo'lsa SMS kerak emas.
        row.delivery?.push !== 'sent',
    );
    if (!due.length) {
      return { checked: rows.length, escalated: 0 };
    }

    const dueIds = due.map((row) => String(row.id));
    if (!this.smsConfig.enabled) {
      await this.patch(dueIds, {
        escalation: 'skipped',
        escalation_reason: 'sms_disabled',
      });
      this.logger.warn(
        `CRITICAL ${dueIds.length} ta bildirishnoma o'qilmadi, lekin SMS o'chiq (SMS_ENABLED=false) — eskalatsiya yo'q.`,
      );
      return { checked: rows.length, escalated: 0, skipped: dueIds.length };
    }

    try {
      const escalated = await this.smsDispatch.escalate(dueIds);
      if (escalated) {
        this.logger.warn(
          `CRITICAL ${escalated} ta bildirishnoma ${this.delayMinutes} daqiqada o'qilmadi — SMS eskalatsiyasi navbatga qo'yildi.`,
        );
      }
      return { checked: rows.length, escalated };
    } catch (error) {
      // Kvota / kill-switch / dublikat — qayta urinish yordam bermaydi (va
      // poison outbox ogohlantirishini keltirardi): holat DB'ga yoziladi.
      if (
        error instanceof SmsBlockedError ||
        error instanceof SmsDuplicateError
      ) {
        const reason =
          error instanceof SmsBlockedError ? error.reason : 'duplicate';
        await this.patch(dueIds, {
          escalation: 'blocked',
          escalation_reason: reason,
        });
        return { checked: rows.length, escalated: 0, blocked: dueIds.length };
      }
      throw error;
    }
  }

  private async patch(ids: string[], patch: Record<string, unknown>) {
    if (!ids.length) return;
    await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds(ids)
      // Shu orada boshqa nusxa eskalatsiya qilgan bo'lsa — ustiga yozilmaydi.
      .andWhere(`("delivery"->>'escalated_at') IS NULL`)
      .execute();
  }
}
