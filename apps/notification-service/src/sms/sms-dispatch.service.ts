import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { rmqSend } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { SmsConfigService } from './sms-config.service';
import { SmsBlockedError } from './sms-gate.service';
import { SmsDuplicateError, SmsOutboxService } from './sms-outbox.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { normalizeSmsPhone } from './sms-phone.util';

export type SmsChannelStatus = 'queued' | 'partial' | 'skipped' | 'blocked';

export interface SmsChannelResult {
  sms: number;
  sms_status: SmsChannelStatus;
  sms_reason?: string;
  sms_skipped?: number;
}

export interface UserContact {
  id: string;
  phone_number: string | null;
  role: string | null;
  language: string | null;
}

/** SMS'ga sig'adigan qisqa matn — sarlavha + tana. */
const smsText = (row: Notification) =>
  [row.title, row.body]
    .filter((part) => part && part.trim())
    .join(': ')
    .slice(0, 640);

/**
 * Umumiy dispatch → SMS kanali (3fRbyadQ #6/#7) va CRITICAL push eskalatsiyasi
 * (Jht84wGp #8).
 */
@Injectable()
export class SmsDispatchService {
  private readonly logger = new Logger(SmsDispatchService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly config: SmsConfigService,
    private readonly outbox: SmsOutboxService,
    private readonly registry: SmsProviderRegistry,
  ) {}

  /** SMS so'ralgan dispatch uchun OLDINDAN tekshiruv: fan-out XATO bo'lsin, kesilmasin. */
  assertFanout(recipients: number) {
    if (recipients > this.config.maxFanout) {
      throw new SmsBlockedError(
        'fanout_exceeded',
        `SMS qabul qiluvchilar soni ${recipients} — chegara ${this.config.maxFanout} (SMS_MAX_FANOUT). Dispatch yuborilmadi.`,
        { requested: recipients, max: this.config.maxFanout },
      );
    }
  }

  async contacts(ids: string[]): Promise<Map<string, UserContact>> {
    const map = new Map<string, UserContact>();
    if (!ids.length) return map;
    const res = await rmqSend<{ data?: UserContact[] } | UserContact[]>(
      this.identityClient,
      { cmd: 'identity.user.contacts_by_ids' },
      { ids },
    );
    const list = Array.isArray(res) ? res : (res?.data ?? []);
    for (const contact of list) map.set(String(contact.id), contact);
    return map;
  }

  /**
   * Inbox qatorlari uchun SMS navbatga (dispatch tranzaksiyasi ichida). Natija
   * har qatorning `delivery.sms` iga DB'da yoziladi — logga emas.
   */
  async queueForNotifications(
    rows: Notification[],
    manager: EntityManager,
  ): Promise<SmsChannelResult> {
    const ids = rows.map((row) => row.id);
    if (!this.config.enabled) {
      await this.patch(manager, ids, {
        sms: 'skipped',
        sms_reason: 'sms_disabled',
      });
      return { sms: 0, sms_status: 'skipped', sms_reason: 'sms_disabled' };
    }
    if (!(await this.registry.hasAccount('default'))) {
      await this.patch(manager, ids, {
        sms: 'skipped',
        sms_reason: 'provider_not_configured',
      });
      return {
        sms: 0,
        sms_status: 'skipped',
        sms_reason: 'provider_not_configured',
      };
    }

    const contacts = await this.contacts([
      ...new Set(rows.map((row) => String(row.recipient_id))),
    ]);
    const withPhone: Notification[] = [];
    const withoutPhone: string[] = [];
    for (const row of rows) {
      const phone = normalizeSmsPhone(
        contacts.get(String(row.recipient_id))?.phone_number,
      );
      if (phone) withPhone.push(row);
      else withoutPhone.push(row.id);
    }
    await this.patch(manager, withoutPhone, {
      sms: 'skipped',
      sms_reason: 'no_phone',
    });
    if (!withPhone.length) {
      return {
        sms: 0,
        sms_status: 'skipped',
        sms_reason: 'no_phone',
        sms_skipped: rows.length,
      };
    }

    try {
      const result = await this.outbox.enqueue(
        withPhone.map((row) => ({
          to: contacts.get(String(row.recipient_id))?.phone_number ?? '',
          text: smsText(row),
          messageClass: 'transactional' as const,
          notificationId: row.id,
          clientMessageId: `notif-${row.id}`,
        })),
        { manager },
      );
      await this.patch(
        manager,
        withPhone.map((row) => row.id),
        { sms: 'queued' },
      );
      return {
        sms: result.queued.length,
        sms_status: withoutPhone.length ? 'partial' : 'queued',
        ...(withoutPhone.length ? { sms_skipped: withoutPhone.length } : {}),
      };
    } catch (error) {
      if (error instanceof SmsBlockedError) {
        await this.patch(
          manager,
          withPhone.map((row) => row.id),
          {
            sms: 'blocked',
            sms_reason: error.reason,
          },
        );
        return { sms: 0, sms_status: 'blocked', sms_reason: error.reason };
      }
      if (error instanceof SmsDuplicateError) {
        return { sms: 0, sms_status: 'skipped', sms_reason: 'duplicate' };
      }
      throw error;
    }
  }

  /**
   * CRITICAL push yetmadi → SMS (Jht84wGp #8). ATIGI BIR MARTA: `escalated_at`
   * bo'sh qatorlar atomik belgilanadi (UPDATE ... WHERE ... RETURNING), shu
   * qatorlarga SMS; `client_message_id = esc-<id>` UNIQUE — qayta urinish
   * ikkinchi SMS yaratmaydi (pul).
   */
  async escalate(notificationIds: string[]): Promise<number> {
    if (!notificationIds.length || !this.config.enabled) return 0;
    const claimed: Notification[] = await this.notifications
      .query(
        `UPDATE "notification_schema"."notifications"
          SET "delivery" = COALESCE("delivery", '{}'::jsonb)
                || jsonb_build_object('escalated_at', to_jsonb(NOW()))
        WHERE "id" = ANY($1::bigint[])
          AND ("delivery"->>'escalated_at') IS NULL
        RETURNING "id", "recipient_id", "title", "body"`,
        [notificationIds],
      )
      .then((result: unknown) =>
        Array.isArray(result) && Array.isArray(result[0])
          ? (result[0] as Notification[])
          : (result as Notification[]),
      );
    if (!claimed.length) return 0;
    const contacts = await this.contacts([
      ...new Set(claimed.map((row) => String(row.recipient_id))),
    ]);
    const messages = claimed
      .map((row) => ({
        row,
        phone: normalizeSmsPhone(
          contacts.get(String(row.recipient_id))?.phone_number,
        ),
      }))
      .filter((item): item is { row: Notification; phone: string } =>
        Boolean(item.phone),
      );
    if (!messages.length) return 0;
    try {
      const result = await this.outbox.enqueue(
        messages.map(({ row, phone }) => ({
          to: phone,
          text: smsText(row),
          messageClass: 'transactional' as const,
          notificationId: String(row.id),
          clientMessageId: `esc-${row.id}`,
        })),
      );
      await this.outbox.patchNotifications(
        messages.map(({ row }) => String(row.id)),
        { sms: 'queued', escalation: 'sms' },
      );
      return result.queued.length;
    } catch (error) {
      this.logger.error(
        `CRITICAL eskalatsiya SMS navbatga tushmadi: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  private async patch(
    manager: EntityManager,
    ids: string[],
    patch: Record<string, unknown>,
  ) {
    if (!ids.length) return;
    await manager
      .getRepository(Notification)
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds(ids)
      .execute();
  }
}
