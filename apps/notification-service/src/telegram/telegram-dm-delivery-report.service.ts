import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_TELEGRAM_DM_DELIVERY_TYPE,
  TELEGRAM_DM_DELIVERY_TYPES,
  type TelegramDmDeliveryType,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Notification } from '../entities/notification.entity';
import { smsReportRange } from '../sms/sms-outbox.service';

/**
 * (2crjWf7v) Yetkazish hisobotidagi bitta kesim (jami / rol / kun).
 *
 *  - `total`       — Telegram DM so'ralgan qatorlar (`delivery.telegram` bor);
 *  - `sent`        — Telegram qabul qildi (yetdi);
 *  - `failed`      — yuborishga urinildi, xato (bloklagan, chat yo'q, …);
 *  - `pending`     — navbatda / yuborilmoqda (`queued` | `sending` | `pending`);
 *  - `skipped`     — ataylab yuborilmadi: Telegram ulanmagan, guruh chati,
 *                    botni bloklagan, foydalanuvchi o'chirgan (sabablari —
 *                    `skipped_reasons`);
 *  - `no_provider` — bot tokeni sozlanmagan;
 *  - `other`       — boshqa holat (kutilmaydi, yo'qolmasin deb sanaladi).
 *
 * Nisbatlar (0..1, 3 xona; maxraj 0 → `null`) Prometheus qoidalari bilan bir xil:
 *  - `delivery_ratio = sent / (sent + failed + pending)` — yuborishga
 *    navbatga qo'yilganlardan yetgani (`bot:dm_delivery_ratio`);
 *  - `reach_ratio = sent / total` — barcha qabul qiluvchilardan (ulanmaganlar
 *    ham) yetgani (`bot:dm_reach_ratio`) — «yozildi ≠ yetadi».
 */
export interface DmDeliveryCounts {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
  no_provider: number;
  other: number;
  delivery_ratio: number | null;
  reach_ratio: number | null;
}

export interface DmDeliveryReport {
  type: TelegramDmDeliveryType;
  from: string;
  to: string;
  totals: DmDeliveryCounts;
  skipped_reasons: Record<string, number>;
  by_role: Array<{ role: string } & DmDeliveryCounts>;
  days: Array<{ day: string } & DmDeliveryCounts>;
}

/** SQL natijasi: (kun, rol, holat, sabab) bo'yicha sanoq. */
export interface DmDeliveryRow {
  day: string;
  role: string | null;
  status: string | null;
  reason: string | null;
  count: number | string;
}

type Bucket = Exclude<
  keyof DmDeliveryCounts,
  'total' | 'delivery_ratio' | 'reach_ratio'
>;

const bucketOf = (status: string | null): Bucket => {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'sending':
    case 'pending':
      return 'pending';
    case 'skipped':
      return 'skipped';
    case 'no_provider':
      return 'no_provider';
    default:
      return 'other';
  }
};

const emptyCounts = (): DmDeliveryCounts => ({
  total: 0,
  sent: 0,
  failed: 0,
  pending: 0,
  skipped: 0,
  no_provider: 0,
  other: 0,
  delivery_ratio: null,
  reach_ratio: null,
});

const slot = (map: Map<string, DmDeliveryCounts>, key: string) => {
  let counts = map.get(key);
  if (!counts) {
    counts = emptyCounts();
    map.set(key, counts);
  }
  return counts;
};

const ratio = (numerator: number, denominator: number) =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

const withRatios = <T extends DmDeliveryCounts>(counts: T): T => ({
  ...counts,
  delivery_ratio: ratio(
    counts.sent,
    counts.sent + counts.failed + counts.pending,
  ),
  reach_ratio: ratio(counts.sent, counts.total),
});

/** Sof funksiya: SQL qatorlari → hisobot (spec'lar DB'siz tekshiradi). */
export function buildDmDeliveryReport(
  rows: DmDeliveryRow[],
  meta: { type: TelegramDmDeliveryType; from: Date; to: Date },
): DmDeliveryReport {
  const totals = emptyCounts();
  const roles = new Map<string, DmDeliveryCounts>();
  const days = new Map<string, DmDeliveryCounts>();
  const skippedReasons: Record<string, number> = {};

  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (!count) continue;
    const bucket = bucketOf(row.status);
    for (const target of [
      totals,
      slot(roles, row.role || 'unknown'),
      slot(days, String(row.day)),
    ]) {
      target.total += count;
      target[bucket] += count;
    }
    if (bucket === 'skipped') {
      const reason = row.reason || 'unknown';
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count;
    }
  }

  return {
    type: meta.type,
    from: meta.from.toISOString(),
    to: meta.to.toISOString(),
    totals: withRatios(totals),
    skipped_reasons: skippedReasons,
    by_role: [...roles.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, counts]) => ({ role, ...withRatios(counts) })),
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({ day, ...withRatios(counts) })),
  };
}

const isDmType = (value: string): value is TelegramDmDeliveryType =>
  (TELEGRAM_DM_DELIVERY_TYPES as readonly string[]).includes(value);

/**
 * (2crjWf7v) «Yetkazish metrikasi: kvitansiya yuborilgan/yetgan nisbati» —
 * SAQLANGAN ma'lumotdan (`notifications.delivery.telegram`), Prometheus
 * hisoblagichlaridan emas: ular xotirada (restart'da nolga tushadi) va
 * Prometheus hali infra'ga ulanmagan (telegram-bot.rules.yml).
 *
 * Faqat o'qish. Davr — Toshkent kunlari (`from`/`to` SMS hisoboti kabi;
 * sukut — oxirgi 30 kun). ⚠️ O'qilgan bildirishnomalar retention bilan
 * (sukut 60 kun, NOTIF_RETENTION_READ_DAYS) o'chadi — uzoqroq davrda eski
 * qatorlar sanoqqa kirmaydi.
 */
@Injectable()
export class TelegramDmDeliveryReportService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  async report(input: { from?: unknown; to?: unknown; type?: unknown }) {
    const rawType =
      typeof input?.type === 'string' && input.type.trim()
        ? input.type.trim()
        : DEFAULT_TELEGRAM_DM_DELIVERY_TYPE;
    if (!isDmType(rawType)) {
      throw new RpcException({
        statusCode: 400,
        message: `type — ${TELEGRAM_DM_DELIVERY_TYPES.join(' | ')}`,
      });
    }
    const range = smsReportRange(
      typeof input?.from === 'string' ? input.from : null,
      typeof input?.to === 'string' ? input.to : null,
    );
    if (!range) {
      throw new RpcException({
        statusCode: 400,
        message: "from/to noto'g'ri (from < to bo'lishi kerak)",
      });
    }

    const rows: DmDeliveryRow[] = await this.notifications.query(
      `SELECT to_char(n."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS "day",
              n."recipient_role" AS "role",
              n."delivery"->>'telegram' AS "status",
              n."delivery"->>'telegram_reason' AS "reason",
              COUNT(*)::int AS "count"
         FROM "notification_schema"."notifications" n
        WHERE n."type" = $1
          AND n."createdAt" >= $2 AND n."createdAt" < $3
          AND n."delivery" ? 'telegram'
        GROUP BY 1, 2, 3, 4`,
      [rawType, range.from, range.to],
    );

    return successRes(
      buildDmDeliveryReport(Array.isArray(rows) ? rows : [], {
        type: rawType,
        from: range.from,
        to: range.to,
      }),
    );
  }

  /**
   * (gWI4gYkw) Smena hisoboti yetkazish holati: `dispatch_id` lar (finance
   * deterministik `client_request_id` si) bo'yicha qatorlarning `delivery`
   * JSONB'i. Faqat o'qish; matn / sarlavha / data QAYTARILMAYDI.
   */
  async byDispatch(input: { dispatch_ids?: unknown }) {
    const ids = (Array.isArray(input?.dispatch_ids) ? input.dispatch_ids : [])
      .map((id) => (typeof id === 'string' ? id.trim().toLowerCase() : ''))
      .filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          id,
        ),
      )
      .slice(0, 500);
    if (!ids.length) return successRes([]);
    const rows = await this.notifications
      .createQueryBuilder('n')
      .select('n.dispatch_id', 'dispatch_id')
      .addSelect('n.recipient_id', 'recipient_id')
      .addSelect('n.delivery', 'delivery')
      .where('n.dispatch_id IN (:...ids)', { ids })
      .getRawMany<{
        dispatch_id: string;
        recipient_id: string;
        delivery: Record<string, unknown> | null;
      }>();
    return successRes(
      rows.map((row) => ({
        dispatch_id: String(row.dispatch_id),
        recipient_id: String(row.recipient_id),
        delivery: row.delivery ?? {},
      })),
    );
  }
}
