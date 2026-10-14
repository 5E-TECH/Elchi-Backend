import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NOTIFICATION_TYPES,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  findNotificationType,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { NotificationPreference } from '../entities/notification-preference.entity';

/**
 * FOYDALANUVCHI SOZLAMALARI (mP1WGG1W) — kim nima olishini qabul qiluvchi
 * o'zi tanlaydi. Dispatch filtri: `resolveRecipients` dan KEYIN, sikldan
 * TASHQARIDA, BITTA `user_id = ANY(...)` so'rovi (`mutesFor`).
 */

/** Sozlanadigan kanallar. `all` — shu scope'dagi hamma kanal. */
export const PREFERENCE_ALL = 'all';
export const PREFERENCE_CHANNELS: readonly string[] = Object.freeze([
  PREFERENCE_ALL,
  NotificationChannel.IN_APP,
  NotificationChannel.REALTIME,
  NotificationChannel.PUSH,
  NotificationChannel.SMS,
  NotificationChannel.EMAIL,
]);

/**
 * Shaxsiy kanallar — sozlama faqat shularga ta'sir qiladi. TELEGRAM —
 * market GURUHIGA relay (shaxsiy kanal emas), sozlama unga tegmaydi.
 */
const PERSONAL_CHANNELS: ReadonlySet<string> = new Set([
  NotificationChannel.REALTIME,
  NotificationChannel.PUSH,
  NotificationChannel.SMS,
  NotificationChannel.EMAIL,
]);

const MAX_ITEMS = 100;

export interface PreferenceRow {
  scope: string;
  channel: string;
  enabled: boolean;
}

export interface MuteContext {
  type: string;
  category: NotificationCategory | string;
  priority?: NotificationPriority | string | null;
  /** Dispatch'da so'ralgan kanallar. */
  channels: readonly string[];
}

/** `'all'` — qabul qiluvchi ro'yxatdan tushadi; Set — o'chirilgan kanallar. */
export type MuteResult = ReadonlySet<string> | 'all';

/**
 * Sozlama bu xabarga ta'sir qiladimi. `marketing` — DOIM (reklama roziligi:
 * critical deb belgilab chetlab o'tib bo'lmaydi). Katalogda
 * `user_can_mute=false` yoki `priority=critical` — HECH QACHON filtrlanmaydi.
 */
export function isMutableNotification(ctx: {
  type: string;
  category: string;
  priority?: string | null;
}): boolean {
  if (ctx.category === NotificationCategory.MARKETING) return true;
  if (findNotificationType(ctx.type)?.user_can_mute === false) return false;
  return ctx.priority !== NotificationPriority.CRITICAL;
}

/** Yozuv yo'q holat: xodim xabarlari YOQIQ, `marketing` O'CHIQ (fail-closed). */
export function defaultEnabled(category: string): boolean {
  return category !== NotificationCategory.MARKETING;
}

/**
 * Bitta foydalanuvchining qatorlari bo'yicha natija (SOF). Ustuvorlik:
 * (tur, kanal) → (tur, all) → (kategoriya, kanal) → (kategoriya, all) →
 * sukut. `in_app` o'chiq — `'all'` (inbox qatorisiz push/sms ham ketmaydi).
 */
export function effectiveMutes(
  rows: readonly PreferenceRow[],
  ctx: MuteContext,
): MuteResult | null {
  const find = (scope: string, channel: string) =>
    rows.find((row) => row.scope === scope && row.channel === channel)?.enabled;
  const enabledFor = (channel: string): boolean =>
    find(ctx.type, channel) ??
    find(ctx.type, PREFERENCE_ALL) ??
    find(ctx.category, channel) ??
    find(ctx.category, PREFERENCE_ALL) ??
    defaultEnabled(ctx.category);

  if (!enabledFor(NotificationChannel.IN_APP)) return 'all';
  const muted = new Set(
    ctx.channels.filter(
      (channel) => PERSONAL_CHANNELS.has(channel) && !enabledFor(channel),
    ),
  );
  return muted.size ? muted : null;
}

const badRequest = (message: string) =>
  new RpcException({ statusCode: 400, message });

const isUserId = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? /^\d{1,19}$/.test(String(value).trim())
    : false;

const CATEGORY_SCOPES: ReadonlySet<string> = new Set(
  Object.values(NotificationCategory),
);
const LOCKED_TYPES: readonly string[] = NOTIFICATION_TYPES.filter(
  (entry) => !entry.user_can_mute,
).map((entry) => entry.key);

@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectRepository(NotificationPreference)
    private readonly repo: Repository<NotificationPreference>,
  ) {}

  /**
   * Dispatch filtri (mP1WGG1W #4): BITTA so'rov, sikl ichida emas. Qaytaradi
   * — faqat ta'sirlangan qabul qiluvchilar (`'all'` yoki o'chirilgan
   * kanallar). Sozlama ta'sir qilmaydigan xabar (critical) — 0 so'rov.
   */
  async mutesFor(
    userIds: readonly string[],
    ctx: MuteContext,
  ): Promise<Map<string, MuteResult>> {
    const result = new Map<string, MuteResult>();
    if (!userIds.length || !isMutableNotification(ctx)) return result;

    const scopes = [...new Set([ctx.type, String(ctx.category)])];
    const rows = await this.repo
      .createQueryBuilder('p')
      .select('p.user_id', 'user_id')
      .addSelect('p.scope', 'scope')
      .addSelect('p.channel', 'channel')
      .addSelect('p.enabled', 'enabled')
      .where('p.user_id = ANY(CAST(:ids AS bigint[]))', { ids: [...userIds] })
      .andWhere('p.scope IN (:...scopes)', { scopes })
      // (mP1WGG1W TUZATISH) o'chirilgan (soft-delete) sozlama filtrlamaydi.
      .andWhere('p.isDeleted = false')
      .getRawMany<{
        user_id: string;
        scope: string;
        channel: string;
        enabled: boolean;
      }>();

    const byUser = new Map<string, PreferenceRow[]>();
    for (const row of rows) {
      const key = String(row.user_id);
      byUser.set(key, [
        ...(byUser.get(key) ?? []),
        { scope: row.scope, channel: row.channel, enabled: row.enabled },
      ]);
    }
    const fallback = effectiveMutes([], ctx);
    for (const id of userIds) {
      const own = byUser.get(String(id));
      const mute = own ? effectiveMutes(own, ctx) : fallback;
      if (mute) result.set(String(id), mute);
    }
    return result;
  }

  /** `GET /notifications/preferences` — FAQAT o'z sozlamasi (user_id JWT'dan). */
  async get(input: { user_id?: unknown }) {
    const userId = this.requireUserId(input?.user_id);
    const rows = await this.repo.find({
      where: { user_id: userId, isDeleted: false },
      order: { scope: 'ASC', channel: 'ASC' },
    });
    return successRes(
      {
        items: rows.map((row) => ({
          scope: row.scope,
          channel: row.channel,
          enabled: row.enabled,
          updated_at: row.updatedAt,
        })),
        channels: PREFERENCE_CHANNELS,
        defaults: {
          [NotificationCategory.MARKETING]: false,
          other: true,
        },
        // `user_can_mute=false` — o'chirib bo'lmaydigan turlar.
        locked_types: LOCKED_TYPES,
      },
      200,
      'Notification preferences',
    );
  }

  /**
   * `PATCH /notifications/preferences` — `items: [{ scope, channel, enabled }]`.
   * `enabled: null` — sozlamani olib tashlash (sukutga qaytish). Critical
   * (`user_can_mute=false`) turni o'chirish — 400.
   */
  async update(input: { user_id?: unknown; items?: unknown }) {
    const userId = this.requireUserId(input?.user_id);
    if (!Array.isArray(input?.items) || !input.items.length) {
      throw badRequest('items must be a non-empty array');
    }
    if (input.items.length > MAX_ITEMS) {
      throw badRequest(`items: ko'pi bilan ${MAX_ITEMS} ta`);
    }

    // Bir so'rovda bir xil (scope, channel) — oxirgisi ustun (ON CONFLICT bir
    // qatorni ikki marta yangilay olmaydi).
    const byKey = new Map<
      string,
      { scope: string; channel: string; enabled: boolean | null }
    >();
    for (const raw of input.items as unknown[]) {
      const item = (raw ?? {}) as {
        scope?: unknown;
        channel?: unknown;
        enabled?: unknown;
      };
      const scope = typeof item.scope === 'string' ? item.scope.trim() : '';
      const channel =
        typeof item.channel === 'string'
          ? item.channel.trim().toLowerCase()
          : '';
      if (!CATEGORY_SCOPES.has(scope) && !findNotificationType(scope)) {
        throw badRequest(
          `scope "${scope.slice(0, 120)}" noma'lum: kategoriya (${[
            ...CATEGORY_SCOPES,
          ].join(', ')}) yoki GET /notifications/types dagi tur`,
        );
      }
      if (!PREFERENCE_CHANNELS.includes(channel)) {
        throw badRequest(
          `channel "${channel.slice(0, 16)}" noma'lum: ${PREFERENCE_CHANNELS.join(', ')}`,
        );
      }
      if (item.enabled !== null && typeof item.enabled !== 'boolean') {
        throw badRequest('enabled must be boolean or null');
      }
      if (
        item.enabled === false &&
        findNotificationType(scope)?.user_can_mute === false
      ) {
        throw badRequest(
          `"${scope}" — muhim (critical) bildirishnoma, uni o'chirib bo'lmaydi`,
        );
      }
      byKey.set(`${scope}\u0000${channel}`, {
        scope,
        channel,
        enabled: item.enabled,
      });
    }

    const items = [...byKey.values()];
    const upserts = items.filter(
      (item): item is { scope: string; channel: string; enabled: boolean } =>
        item.enabled !== null,
    );
    const resets = items.filter((item) => item.enabled === null);

    await this.repo.manager.transaction(async (manager) => {
      if (upserts.length) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(NotificationPreference)
          .values(
            upserts.map((item) => ({
              user_id: userId,
              scope: item.scope,
              channel: item.channel,
              enabled: item.enabled,
              isDeleted: false,
            })),
          )
          .orUpdate(
            ['enabled', 'is_deleted', 'updatedAt'],
            ['user_id', 'scope', 'channel'],
          )
          .execute();
      }
      for (const item of resets) {
        await manager.update(
          NotificationPreference,
          { user_id: userId, scope: item.scope, channel: item.channel },
          { isDeleted: true },
        );
      }
    });

    return this.get({ user_id: userId });
  }

  private requireUserId(value: unknown): string {
    if (!isUserId(value)) {
      throw badRequest('user_id must be a bigint-like numeric string');
    }
    return String(value).trim();
  }
}
