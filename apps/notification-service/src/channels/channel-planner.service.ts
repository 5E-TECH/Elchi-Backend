import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationPriority,
} from '@app/common';
import { PushSubscription } from '../entities/push-subscription.entity';
import {
  MuteResult,
  NotificationPreferencesService,
} from '../preferences/notification-preferences.service';
import { WebPushService } from '../push/web-push.service';
import { SmsConfigService } from '../sms/sms-config.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import { normalizeSmsPhone } from '../sms/sms-phone.util';
import {
  ChannelBlock,
  ResolvedChannels,
  requestedChannels,
  resolveChannels,
} from './resolve-channels';

export interface PlanInput {
  type: string;
  category: NotificationCategory | string;
  priority: NotificationPriority | string;
  /** Chaqiruvchi so'ragan kanallar (bo'lmasa — katalog sukuti). */
  requested?: readonly string[] | null;
  recipientIds: readonly string[];
}

export interface DispatchPlan {
  /** Katalog ∩ chaqiruvchi — `notifications.channels`. */
  channels: NotificationChannel[];
  /** Har qabul qiluvchi uchun kanal rejasi (excluded'lar ham). */
  byRecipient: Map<string, ResolvedChannels>;
  /** Sozlama bilan ro'yxatdan tushganlar (`skipped_by_preference`). */
  skippedByPreference: string[];
}

/**
 * KANAL REJASI (7Ec56EIw + mP1WGG1W) — barcha I/O shu yerda va BULK:
 *   • sozlamalar — 1 ta SQL (`mutesFor`);
 *   • push obunasi — 1 ta SQL (push so'ralgan va VAPID bor bo'lsa);
 *   • telefon raqami — 1 ta identity RPC (sms so'ralgan va SMS yoqiq bo'lsa).
 * Keyin har qabul qiluvchi uchun SOF `resolveChannels` — sikl ichida I/O YO'Q.
 */
@Injectable()
export class ChannelPlannerService {
  private readonly logger = new Logger(ChannelPlannerService.name);

  constructor(
    private readonly preferences: NotificationPreferencesService,
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
    private readonly webPush: WebPushService,
    private readonly smsConfig: SmsConfigService,
    private readonly smsDispatch: SmsDispatchService,
  ) {}

  async plan(input: PlanInput): Promise<DispatchPlan> {
    const channels = requestedChannels(input.type, input.requested);
    const ids = [...new Set(input.recipientIds.map(String))];

    const mutes = await this.preferences.mutesFor(ids, {
      type: input.type,
      category: input.category,
      priority: input.priority,
      channels,
    });
    const candidates = ids.filter((id) => mutes.get(id) !== 'all');

    const blocked = new Map<
      string,
      Partial<Record<NotificationChannel, ChannelBlock>>
    >();
    const block = (
      id: string,
      channel: NotificationChannel,
      value: ChannelBlock,
    ) => blocked.set(id, { ...(blocked.get(id) ?? {}), [channel]: value });

    if (
      candidates.length &&
      this.wantsPersonal(channels, mutes, candidates, NotificationChannel.PUSH)
    ) {
      await this.planPush(candidates, block);
    }
    if (
      candidates.length &&
      this.wantsPersonal(channels, mutes, candidates, NotificationChannel.SMS)
    ) {
      await this.planSms(candidates, block);
    }

    const byRecipient = new Map<string, ResolvedChannels>();
    const skippedByPreference: string[] = [];
    for (const id of ids) {
      const resolved = resolveChannels(input.type, channels, {
        muted: mutes.get(id) ?? null,
        blocked: blocked.get(id),
      });
      byRecipient.set(id, resolved);
      if (resolved.excluded) skippedByPreference.push(id);
    }
    return { channels, byRecipient, skippedByPreference };
  }

  /** Kanal so'ralgan va kamida bitta nomzod uni o'chirmagan. */
  private wantsPersonal(
    channels: NotificationChannel[],
    mutes: Map<string, MuteResult>,
    candidates: string[],
    channel: NotificationChannel,
  ): boolean {
    if (!channels.includes(channel)) return false;
    return candidates.some((id) => {
      const mute = mutes.get(id);
      return !mute || (mute !== 'all' && !mute.has(channel));
    });
  }

  /**
   * Push imkoniyati: VAPID yo'q (prod hozircha) — `no_provider`, navbatga
   * QO'YILMAYDI (servis ishlayveradi, boshqa kanallar ketadi). Obuna yo'q —
   * `no_subscription` (Jht84wGp TC3), outbox hodisasi ham yaratilmaydi.
   */
  private async planPush(
    candidates: string[],
    block: (id: string, channel: NotificationChannel, v: ChannelBlock) => void,
  ) {
    if (!this.webPush.enabled) {
      for (const id of candidates) {
        block(id, NotificationChannel.PUSH, {
          status: NotificationDeliveryStatus.NO_PROVIDER,
          reason: 'push_disabled',
        });
      }
      return;
    }
    const rows = await this.subscriptions
      .createQueryBuilder('s')
      .select('DISTINCT s.user_id', 'user_id')
      .where({ user_id: In(candidates) })
      .getRawMany<{ user_id: string }>();
    const subscribed = new Set(rows.map((row) => String(row.user_id)));
    for (const id of candidates) {
      if (!subscribed.has(id)) {
        block(id, NotificationChannel.PUSH, {
          status: NotificationDeliveryStatus.NO_SUBSCRIPTION,
        });
      }
    }
  }

  /**
   * SMS imkoniyati — telefon raqami (7Ec56EIw TC7: `not_eligible`). SMS
   * o'chiq bo'lsa tekshirilmaydi: `queueForNotifications` `no_provider`
   * yozadi. Identity javob bermasa — imkoniyat noma'lum, SMS servisi o'zi
   * hal qiladi (avvalgi xulq).
   */
  private async planSms(
    candidates: string[],
    block: (id: string, channel: NotificationChannel, v: ChannelBlock) => void,
  ) {
    if (!this.smsConfig.enabled) return;
    let contacts: Map<string, { phone_number: string | null }>;
    try {
      contacts = await this.smsDispatch.contacts(candidates);
    } catch (error) {
      this.logger.warn(
        `SMS imkoniyatini tekshirib bo'lmadi (identity): ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return;
    }
    for (const id of candidates) {
      if (!normalizeSmsPhone(contacts.get(id)?.phone_number)) {
        block(id, NotificationChannel.SMS, {
          status: NotificationDeliveryStatus.NOT_ELIGIBLE,
          reason: 'no_phone',
        });
      }
    }
  }
}
