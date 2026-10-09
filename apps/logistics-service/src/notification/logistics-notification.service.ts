import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { EntityManager } from 'typeorm';
import {
  BranchUserRole,
  OutboxService,
  findNotificationType,
  renderNotificationGroupKey,
} from '@app/common';

/**
 * HODISA → BILDIRISHNOMA (ePpLHPX2) — logistics-service.
 *
 * `logistics.batch_arrived` — filiallararo pochta (partiya) manzil filialga
 * qabul qilindi (`receivePost`). Nishon — qabul qiluvchi filial xodimlari
 * (branch_users: MANAGER / REGISTRATOR; kuryerlar emas).
 *
 * NISHONNI ANIQLASH. notification-service `roles` bo'yicha GLOBAL tarqatadi
 * (filial doirasi yo'q) — `roles: ['manager']` BARCHA filial menejerlariga
 * ketardi. Shuning uchun xodimlar `branch.user.find_by_branch` dan aniq
 * `recipient_ids` sifatida olinadi:
 *   • tranzaksiyadan OLDIN (va order yangilashlari bilan parallel) — biznes
 *     tranzaksiyasi ichida RPC YO'Q;
 *   • qisqa timeout (`BRANCH_STAFF_LOOKUP_TIMEOUT_MS`) + filial bo'yicha qisqa
 *     kesh (`BRANCH_STAFF_CACHE_TTL_MS`);
 *   • fail-open: branch-service javob bermasa / rad etsa — bo'sh ro'yxat,
 *     bildirishnoma yo'q, pochta qabul qilish avvalgidek o'tadi.
 *
 * ⚠️ FAQAT OUTBOX (pochta holati yozuvi bilan BITTA tranzaksiyada);
 * to'g'ridan-to'g'ri rmqSend / client.send TAQIQ.
 *
 * PII: in_app `body` — faqat pochta raqami + buyurtmalar soni (telefon /
 * manzil YO'Q).
 */

export const NOTIFICATION_OUTBOX_TARGET = 'NOTIFICATION';
export const NOTIFICATION_DISPATCH_PATTERN = 'notification.dispatch';

/** Shu servis yuboradigan turlar — kalitlar `NOTIFICATION_TYPES` katalogida. */
export const LOGISTICS_NOTIFICATION_TYPES = [
  'logistics.batch_arrived',
] as const;

export type LogisticsNotificationType =
  (typeof LOGISTICS_NOTIFICATION_TYPES)[number];

/** Filial xodimlarini qidirish chegarasi — pochta qabul qilishni sekinlatmasin. */
export const BRANCH_STAFF_LOOKUP_TIMEOUT_MS = 1500;
/** Filial xodimlari ro'yxati keshi (faqat muvaffaqiyatli javob keshlanadi). */
export const BRANCH_STAFF_CACHE_TTL_MS = 60_000;

/** Pochta qabul qiladigan filial xodimlari (branch_users.role). */
const BRANCH_STAFF_ROLES: ReadonlySet<string> = new Set<string>([
  BranchUserRole.MANAGER,
  BranchUserRole.REGISTRATOR,
]);

export interface LogisticsNotificationPayload {
  type: LogisticsNotificationType;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids: string[];
  group_key?: string;
  channels: string[];
}

export interface BatchArrivedInput {
  post_id: string | number | null | undefined;
  branch_id: string | number | null | undefined;
  /** Shu qabulda filialga tushgan (WAITING ga o'tgan) buyurtmalar soni. */
  received_count: number;
  /** Pochtadagi jami buyurtmalar. */
  order_count: number;
  /** Saqlangandan keyingi pochta holati (RECEIVED yoki qisman bo'lsa SENT). */
  status?: string | null;
  recipient_ids: readonly (string | number | null | undefined)[];
}

export interface StaffLookupRequester {
  id?: string | null;
  roles?: string[];
}

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value).trim()) &&
  !/^0+$/.test(String(value).trim());

/** Mijozga ko'rinadigan pochta havolasi (frontend `MailDetail`). */
export const postLink = (postId: string) => `/mails/${postId}`;

/**
 * `logistics.batch_arrived` payload'i. Qabul qiluvchi yo'q yoki hech narsa
 * qabul qilinmagan bo'lsa — `null`.
 */
export function buildBatchArrivedPayload(
  input: BatchArrivedInput,
): LogisticsNotificationPayload | null {
  const type: LogisticsNotificationType = 'logistics.batch_arrived';
  const entry = findNotificationType(type);
  const recipientIds = [
    ...new Set(
      (input.recipient_ids ?? []).filter(isId).map((id) => String(id).trim()),
    ),
  ];
  const received = Math.max(Math.trunc(Number(input.received_count) || 0), 0);
  if (!entry || !isId(input.post_id) || !recipientIds.length || !received) {
    return null;
  }

  const postId = String(input.post_id);
  const total = Math.max(Math.trunc(Number(input.order_count) || 0), received);
  const data: Record<string, unknown> = {
    post_id: postId,
    received_count: received,
    order_count: total,
    ...(isId(input.branch_id) ? { branch_id: String(input.branch_id) } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: 'Pochta filialga yetib keldi',
    // in_app: faqat raqam + son (PII yo'q).
    body: `Pochta #${postId} filialga qabul qilindi: ${received} ta buyurtma.`,
    data,
    link: postLink(postId),
    recipient_ids: recipientIds,
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

@Injectable()
export class LogisticsNotificationService {
  private readonly logger = new Logger(LogisticsNotificationService.name);
  private readonly staffCache = new Map<
    string,
    { ids: string[]; expiresAt: number }
  >();

  constructor(
    private readonly outbox: OutboxService,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
  ) {}

  /**
   * Filial xodimlari (MANAGER / REGISTRATOR) user id lari. HECH QACHON reject
   * bo'lmaydi: xato / timeout / rad etish — `[]` (bildirishnoma yo'q).
   */
  async resolveBranchStaffIds(
    branchId: string | number | null | undefined,
    requester?: StaffLookupRequester | null,
  ): Promise<string[]> {
    const id = String(branchId ?? '').trim();
    if (!isId(id)) return [];

    const cached = this.staffCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return [...cached.ids];

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send<{ data?: unknown }>(
            { cmd: 'branch.user.find_by_branch' },
            {
              branch_id: id,
              requester: {
                id: String(requester?.id ?? ''),
                roles: requester?.roles ?? [],
              },
            },
          )
          .pipe(timeout(BRANCH_STAFF_LOOKUP_TIMEOUT_MS)),
      );
      const rows: unknown[] = Array.isArray(response?.data)
        ? response.data
        : [];
      const text = (value: unknown) =>
        typeof value === 'string' || typeof value === 'number'
          ? String(value).trim()
          : '';
      const ids = [
        ...new Set(
          rows
            .filter((row): row is { user_id?: unknown; role?: unknown } =>
              Boolean(row && typeof row === 'object'),
            )
            .filter((row) =>
              BRANCH_STAFF_ROLES.has(text(row.role).toUpperCase()),
            )
            .map((row) => text(row.user_id))
            .filter(isId),
        ),
      ];
      this.staffCache.set(id, {
        ids,
        expiresAt: Date.now() + BRANCH_STAFF_CACHE_TTL_MS,
      });
      return [...ids];
    } catch (err) {
      this.logger.warn(
        `branch staff lookup (branch=${id}) yiqildi — bildirishnoma yuborilmaydi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return [];
    }
  }

  /**
   * Pochta filialga qabul qilindi. `manager` — pochta holati yozilgan
   * tranzaksiya: outbox qatori ham AYNAN shunda.
   */
  async onBatchArrived(
    input: BatchArrivedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);

    let payload: LogisticsNotificationPayload | null = null;
    try {
      payload = buildBatchArrivedPayload(input);
    } catch (err) {
      this.logger.warn(
        `logistics notification payload (post=${String(input.post_id ?? '')}) qurilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return;
    }
    if (!payload) return;

    try {
      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        NOTIFICATION_DISPATCH_PATTERN,
        payload,
        manager ? { manager } : {},
      );
    } catch (err) {
      // Tranzaksiya ichida DB xatosi — chaqiruvchi rollback qilsin.
      if (inTransaction) throw err;
      this.logger.warn(
        `logistics notification (post=${String(input.post_id ?? '')}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }
}
