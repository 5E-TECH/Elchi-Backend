import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogService,
  NotificationChannel,
  OutboxService,
  maskPhonesForLog,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { SmsCampaign } from '../entities/sms-campaign.entity';
import { UNDELIVERED_STATUSES } from '../history/dispatch-history.service';
import { SmsConfigService } from '../sms/sms-config.service';
import { maskPhone } from '../sms/sms-phone.util';
import { countSmsSegments } from '../sms/sms-segments.util';
import { SMS_DLR_FINAL_FAILURES } from '../sms/sms.port';
import {
  CAMPAIGN_REPORT_KINDS,
  CampaignReportExport,
  CampaignReportKind,
} from './campaign-report-export.entity';
import { campaignDisplayStatus, toTashkentIso } from './campaign-schedule';
import {
  CAMPAIGN_TERMINAL_STATUSES,
  NotificationCampaign,
} from './notification-campaign.entity';

/** Outbox iste'molchisi — katta eksportni fonda yig'adi (ichki). */
export const CAMPAIGN_EXPORT_RUN_PATTERN = 'notification.campaign.export.run';
/** Shundan katta eksport SINXRON bajarilmaydi — fon vazifasi (karta: 10 000). */
export const CAMPAIGN_EXPORT_SYNC_MAX_ROWS = 10_000;
/** Bitta eksportning yuqori chegarasi (= kampaniya auditoriyasi shifti). */
export const CAMPAIGN_EXPORT_MAX_ROWS = 100_000;
/** Tayyor fayl shuncha vaqt yuklab olinadi, keyin CSV matni tozalanadi. */
export const CAMPAIGN_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `running` da shuncha turgan vazifa — jarayon uzilgan deb hisoblanadi. */
const EXPORT_STALE_MS = 10 * 60 * 1000;
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const PAGE_MAX = 100;
const EXPORT_PAGE = 1000;
/** identity `find_by_ids` bir chaqiruvda ko'pi bilan 500 id oladi. */
const NAME_CHUNK = 500;
const ERROR_MAX = 300;
const ID_RE = /^\d{1,19}$/;
const FIND_BY_IDS = { cmd: 'identity.user.find_by_ids' };

const CHANNEL_KEYS: readonly string[] = Object.values(NotificationChannel);
/** Tashqi kanallar — in_app (qatorning o'zi) "yetkazilmadi" hisobiga kirmaydi. */
const EXTERNAL_CHANNELS: readonly string[] = CHANNEL_KEYS.filter(
  (channel) => channel !== NotificationChannel.IN_APP,
);

/**
 * Kanal holati → hisobot ustuni. `emitted` (realtime brokerga topshirildi)
 * va `sent` — yuborildi; `queued/pending/processing/accepted` — jarayonda;
 * `failed` — xato; qolgan "yetkazilmadi" holatlari (skipped, no_provider,
 * not_eligible, no_subscription, blocked) — o'tkazib yuborildi.
 */
const SENT_STATUSES = ['sent', 'emitted', 'delivered'];
const PENDING_STATUSES = ['pending', 'queued', 'processing', 'accepted'];
const FAILED_STATUSES = ['failed'];

type Bucket = 'sent' | 'failed' | 'skipped' | 'pending' | 'other';

const bucketOf = (status: string): Bucket => {
  if (SENT_STATUSES.includes(status)) return 'sent';
  if (FAILED_STATUSES.includes(status)) return 'failed';
  if (PENDING_STATUSES.includes(status)) return 'pending';
  if (UNDELIVERED_STATUSES.includes(status)) return 'skipped';
  return 'other';
};

interface Requester {
  id?: string | number | null;
  roles?: string[] | null;
}

export interface CampaignReportInput {
  kind?: unknown;
  id?: unknown;
  requester?: Requester | null;
}

export interface UndeliveredItem {
  /** notifications.id yoki sms_outbox.id. */
  ref_id: string;
  recipient_id: string | null;
  name: string | null;
  role: string | null;
  /** Faqat maskalangan (`***7434`) — to'liq raqam hech qachon chiqmaydi. */
  phone: string | null;
  failures: Array<{ channel: string; status: string; reason: string | null }>;
}

interface NotificationUndeliveredRow {
  id: string;
  recipient_id: string;
  recipient_role: string | null;
  delivery: Record<string, unknown> | null;
}

interface SmsUndeliveredRow {
  id: string;
  customer_id: string | null;
  to_phone: string;
  last_error: string | null;
  dlr_status: string | null;
  status: string;
}

/** Faqat primitiv qiymat matnga (obyekt → ""). */
const text = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const shortError = (error: unknown): string =>
  maskPhonesForLog(
    (error instanceof Error ? error.message : text(error) || 'unknown')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, ERROR_MAX);

/** CSV katagi: formula in'ektsiyasi (= + - @) zararsizlanadi, kerak bo'lsa qo'shtirnoq. */
export const csvCell = (value: unknown): string => {
  let cell = value === null || value === undefined ? '' : text(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n;]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

const isSuperadmin = (requester: Requester | null | undefined) =>
  (requester?.roles ?? []).some(
    (role) => text(role).trim().toLowerCase() === 'superadmin',
  );

const actorId = (requester: Requester | null | undefined): string | null => {
  const raw = text(requester?.id).trim();
  return ID_RE.test(raw) ? raw : null;
};

const actorRoles = (requester: Requester | null | undefined) =>
  (requester?.roles ?? []).map((role) => text(role)).filter(Boolean);
/** CSV ustunlari — bitta qator = bitta qabul qiluvchi. */
const CSV_HEADER = [
  'recipient_id',
  'name',
  'role',
  'phone',
  'channel',
  'status',
  'reason',
  'ref_id',
];
/** UTF-8 BOM — Excel kirill/o'zbekchani to'g'ri ochsin. */
const CSV_BOM = String.fromCharCode(0xfeff);
const CSV_EOL = String.fromCharCode(13, 10);

const csvLine = (item: UndeliveredItem): string =>
  [
    item.recipient_id,
    item.name,
    item.role,
    item.phone,
    item.failures.map((failure) => failure.channel).join(' | '),
    item.failures.map((failure) => failure.status).join(' | '),
    item.failures.map((failure) => failure.reason ?? '').join(' | '),
    item.ref_id,
  ]
    .map(csvCell)
    .join(',');

/**
 * KAMPANIYA NATIJASI HISOBOTI (H7kpCman) — "nima bo'ldi va qanchaga
 * tushdi?" bitta javobda:
 *
 *   - Auditoriya / Yuborildi / Yetkazildi (DLR) / Xato / O'tkazib
 *     yuborildi / Taxminiy narx;
 *   - kanal kesimi (in_app / realtime / telegram / sms / push) — har biri
 *     sent / failed / skipped / pending + xom holatlar;
 *   - SMS bloki (bo'laklar, kodlash, narx) — FAQAT SMS kampaniyasida;
 *     bildirishnoma kampaniyasida (in_app/realtime/push) `sms: null`;
 *   - "Yetkazilmaganlar" — ism / rol + sabab; CSV eksport faqat superadmin,
 *     eksportning o'zi faoliyat jurnaliga `export` amali bilan yoziladi;
 *     10 000 qatordan katta eksport — fon vazifasi (sinxron emas).
 *
 * ⚠️ O'lchanmagan qiymat `null` (frontend "—" ko'rsatadi), HECH QACHON 0
 * emas: DLR hali kelmagan bo'lsa `delivered: null` (0% = hammasi yiqildi
 * degan yolg'on signal). Narx — TAXMIN (tarif × bo'laklar), faktik summa
 * provayder hisobidan keladi.
 */
@Injectable()
export class CampaignReportService {
  private readonly logger = new Logger(CampaignReportService.name);
  /** Fonda yig'ilayotgan eksportlar (test va graceful kutish uchun). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(NotificationCampaign)
    private readonly campaigns: Repository<NotificationCampaign>,
    @InjectRepository(SmsCampaign)
    private readonly smsCampaigns: Repository<SmsCampaign>,
    @InjectRepository(CampaignReportExport)
    private readonly exports: Repository<CampaignReportExport>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly activityLog: ActivityLogService,
    private readonly smsConfig: SmsConfigService,
  ) {}

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) throw error;
    for (const [type, statusCode] of [
      [BadRequestException, 400],
      [ForbiddenException, 403],
      [NotFoundException, 404],
      [ConflictException, 409],
      [GoneException, 410],
    ] as const) {
      if (error instanceof type) {
        throw new RpcException({ statusCode, message: error.message });
      }
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private kindOf(raw: unknown): CampaignReportKind {
    const kind = text(raw).trim() || 'notification';
    if (!CAMPAIGN_REPORT_KINDS.includes(kind as CampaignReportKind)) {
      throw new BadRequestException(
        `kind: ${CAMPAIGN_REPORT_KINDS.join(' | ')}`,
      );
    }
    return kind as CampaignReportKind;
  }

  private idOf(raw: unknown, field = 'id'): string {
    const id = text(raw).trim();
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`${field} must be a bigint-like string`);
    }
    return id;
  }

  private assertSuperadmin(requester: Requester | null | undefined) {
    if (!isSuperadmin(requester)) {
      throw new ForbiddenException(
        'CSV eksport faqat superadmin uchun (telefon/ism tizimdan chiqadi)',
      );
    }
  }

  private groupKey(id: string) {
    return `campaign:${id}`;
  }

  // ==================== REPORT ====================

  async report(input: CampaignReportInput = {}) {
    try {
      const kind = this.kindOf(input?.kind);
      const id = this.idOf(input?.id);
      const body =
        kind === 'sms'
          ? await this.smsReport(id)
          : await this.notificationReport(id);
      return successRes(
        {
          ...body,
          permissions: { can_export: isSuperadmin(input?.requester) },
          export_sync_limit: CAMPAIGN_EXPORT_SYNC_MAX_ROWS,
        },
        200,
        'Campaign report',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private async notificationCampaign(id: string) {
    const campaign = await this.campaigns.findOne({
      where: { id, isDeleted: false },
    });
    if (!campaign) throw new NotFoundException('Kampaniya topilmadi');
    return campaign;
  }

  private async smsCampaign(id: string) {
    const campaign = await this.smsCampaigns.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException('SMS kampaniya topilmadi');
    return campaign;
  }

  private async notificationReport(id: string) {
    const campaign = await this.notificationCampaign(id);
    const rows: Array<{ channel: string; status: string; n: number }> =
      await this.campaigns.query(
        `SELECT e.key AS "channel", e.value AS "status", COUNT(*)::int AS "n"
           FROM "notification_schema"."notifications" n,
                jsonb_each_text(COALESCE(n."delivery", '{}'::jsonb)) e
          WHERE n."group_key" = $1
            AND n."data"->>'campaign_id' = $2
            AND e.key = ANY($3::text[])
          GROUP BY 1, 2`,
        [this.groupKey(id), id, [...CHANNEL_KEYS]],
      );
    const undelivered = await this.countUndelivered('notification', id);

    const channels = [
      ...new Set([NotificationChannel.IN_APP as string, ...campaign.channels]),
    ];
    const byChannel = channels.map((channel) => {
      const statuses: Record<string, number> = {};
      for (const row of rows) {
        if (row.channel === channel) statuses[row.status] = num(row.n);
      }
      const buckets = { sent: 0, failed: 0, skipped: 0, pending: 0, other: 0 };
      for (const [status, n] of Object.entries(statuses)) {
        buckets[bucketOf(status)] += n;
      }
      if (channel === NotificationChannel.IN_APP) {
        // Qatori umuman yozilmaganlar (partiya qayta-qayta yiqilgan) va
        // yakunda yetib bormaganlar (bekor qilish qoldig'i) — in_app da.
        buckets.failed += campaign.failed;
        buckets.skipped += campaign.skipped;
      }
      return { channel, ...buckets, statuses };
    });

    const terminal = CAMPAIGN_TERMINAL_STATUSES.includes(campaign.status);
    return {
      kind: 'notification' as const,
      campaign: {
        id: String(campaign.id),
        title: campaign.title,
        type: campaign.type,
        category: campaign.category,
        status: campaign.status,
        display_status: campaignDisplayStatus(campaign),
        channels: campaign.channels,
        created_by: campaign.created_by,
        created_at: campaign.createdAt,
        scheduled_at: campaign.scheduled_at,
        scheduled_at_tashkent: toTashkentIso(campaign.scheduled_at),
        started_at: campaign.started_at,
        finished_at: campaign.finished_at,
      },
      stats: {
        audience: campaign.total,
        sent: campaign.sent,
        // in_app / realtime / push uchun provayder DLR yo'q — o'lchanmaydi.
        delivered: null,
        failed: campaign.failed,
        skipped: campaign.skipped,
        pending: terminal
          ? 0
          : Math.max(
              campaign.total -
                campaign.sent -
                campaign.failed -
                campaign.skipped,
              0,
            ),
        undelivered,
        /** Qatori yozilmay qolganlar — kimligi noma'lum, ro'yxatda yo'q. */
        unlisted_failed: campaign.failed,
      },
      dlr: {
        supported: false,
        received: null,
        awaiting: null,
        note: "in_app / realtime / push kanallarida provayder yetkazish hisoboti (DLR) yo'q — 'Yetkazildi' o'lchanmaydi (—)",
      },
      by_channel: byChannel,
      sms: null,
      cost: {
        currency: 'UZS',
        estimated: 0,
        cost_of_sent: 0,
        is_estimate: true,
        paid_channels: [] as string[],
        note: "Bepul kanallar (in_app / realtime / push) — provayder to'lovi yo'q",
      },
    };
  }

  private async smsReport(id: string) {
    const campaign = await this.smsCampaign(id);
    const finalDlr = ['delivered', ...SMS_DLR_FINAL_FAILURES];
    const aggRows: Array<Record<string, unknown>> = await this.campaigns.query(
      `SELECT COUNT(*)::int AS "messages",
              COUNT(*) FILTER (WHERE o."sent_at" IS NOT NULL)::int AS "sent",
              COUNT(*) FILTER (WHERE o."status" = 'delivered')::int AS "delivered",
              COUNT(*) FILTER (WHERE o."status" = 'failed')::int AS "failed",
              COUNT(*) FILTER (WHERE o."status" IN ('pending', 'processing'))::int AS "pending",
              COUNT(*) FILTER (WHERE o."dlr_status" = ANY($2::text[]))::int AS "dlr_final",
              COUNT(*) FILTER (WHERE o."status" = 'sent')::int AS "awaiting_dlr",
              COALESCE(SUM(o."parts"), 0)::int AS "parts_total",
              MIN(o."parts")::int AS "parts_min",
              MAX(o."parts")::int AS "parts_max",
              COUNT(*) FILTER (WHERE o."encoding" = 'GSM-7')::int AS "gsm7",
              COUNT(*) FILTER (WHERE o."encoding" = 'UCS-2')::int AS "ucs2",
              SUM(o."cost") FILTER (WHERE o."sent_at" IS NOT NULL) AS "cost_of_sent",
              COUNT(*) FILTER (WHERE o."sent_at" IS NOT NULL AND o."cost" IS NULL)::int AS "untariffed_sent"
         FROM "notification_schema"."sms_outbox" o
        WHERE o."campaign_id" = $1`,
      [id, finalDlr],
    );
    const agg = aggRows[0] ?? {};
    const statusRows: Array<{ status: string; n: number }> =
      await this.campaigns.query(
        `SELECT o."status" AS "status", COUNT(*)::int AS "n"
           FROM "notification_schema"."sms_outbox" o
          WHERE o."campaign_id" = $1
          GROUP BY 1`,
        [id],
      );
    const messages = num(agg.messages);
    const sent = num(agg.sent);
    const deliveredCount = num(agg.delivered);
    const failed = num(agg.failed);
    const pending = num(agg.pending);
    const dlrFinal = num(agg.dlr_final);
    const awaiting = num(agg.awaiting_dlr);
    const gsm7 = num(agg.gsm7);
    const ucs2 = num(agg.ucs2);
    const skipped = campaign.skipped + campaign.blocked;
    // DLR hali kelmagan — "Yetkazildi" o'lchanmagan: null (0 EMAS).
    const delivered = dlrFinal > 0 ? deliveredCount : null;

    const statuses: Record<string, number> = {};
    for (const row of statusRows) statuses[row.status] = num(row.n);
    const channel = {
      channel: NotificationChannel.SMS as string,
      sent: (statuses.sent ?? 0) + (statuses.delivered ?? 0),
      failed,
      skipped,
      pending,
      other: 0,
      statuses,
    };

    // Bo'laklar/kodlash: navbatdagi haqiqiy xabarlardan (opt-out havolasi
    // bilan); bitta ham xabar yo'q bo'lsa — kampaniya matnidan (prognoz).
    const fromText = countSmsSegments(campaign.text);
    const encoding = messages
      ? gsm7 && ucs2
        ? 'mixed'
        : ucs2
          ? 'UCS-2'
          : 'GSM-7'
      : fromText.encoding;
    const costRaw = agg.cost_of_sent;
    const costOfSent =
      sent === 0
        ? 0
        : num(agg.untariffed_sent) > 0 ||
            costRaw === null ||
            costRaw === undefined
          ? null
          : num(costRaw);
    const estimated =
      campaign.estimated_cost === null || campaign.estimated_cost === undefined
        ? null
        : num(campaign.estimated_cost);
    const partsPerMessage = messages
      ? { min: num(agg.parts_min), max: num(agg.parts_max) }
      : { min: fromText.parts, max: fromText.parts };
    const encodingBreakdown: Record<string, number> = {};
    encodingBreakdown['GSM-7'] = gsm7;
    encodingBreakdown['UCS-2'] = ucs2;

    return {
      kind: 'sms' as const,
      campaign: {
        id: String(campaign.id),
        title: null,
        text: campaign.text,
        message_class: campaign.message_class,
        template_code: campaign.template_code,
        status: campaign.status,
        channels: [NotificationChannel.SMS as string],
        created_by: campaign.created_by,
        created_at: campaign.created_at,
      },
      stats: {
        audience: campaign.total,
        /** Provayder qabul qilgan (keyin DLR rad etganlar ham). */
        sent,
        delivered,
        failed,
        skipped,
        skipped_breakdown: {
          invalid_phone: campaign.skipped,
          no_consent: campaign.blocked,
        },
        pending,
        undelivered: failed,
        unlisted_failed: 0,
      },
      dlr: {
        supported: true,
        received: dlrFinal,
        awaiting,
        note:
          dlrFinal > 0
            ? null
            : "Yetkazish hisoboti (DLR) hali kelmagan — 'Yetkazildi' o'lchanmagan (—), 0 emas",
      },
      by_channel: [channel],
      sms: {
        messages,
        parts_total: num(agg.parts_total),
        parts_per_message: partsPerMessage,
        encoding,
        encoding_breakdown: encodingBreakdown,
        source: messages ? 'sms_outbox' : 'text',
        dlr: {
          final: dlrFinal,
          delivered: deliveredCount,
          failed: Math.max(dlrFinal - deliveredCount, 0),
          awaiting,
        },
        tariff_per_part: this.smsConfig.tariff(campaign.message_class),
        cost_of_sent: costOfSent,
      },
      cost: {
        currency: 'UZS',
        /** Yuborishdan oldingi prognoz (tarif sozlanmagan bo'lsa null). */
        estimated,
        /** Provayder qabul qilgan xabarlar bo'yicha (tarif × bo'lak). */
        cost_of_sent: costOfSent,
        is_estimate: true,
        paid_channels: [NotificationChannel.SMS as string],
        note: "Taxminiy: tarif (SMS_TARIFF_PROMO) × bo'laklar. Faktik summa — provayder hisobidan",
      },
    };
  }

  // ==================== UNDELIVERED ====================

  /** Yetkazilmaganlar soni (eksport hajmi shundan tanlanadi). */
  async countUndelivered(
    kind: CampaignReportKind,
    id: string,
  ): Promise<number> {
    const rows: Array<{ n: number }> =
      kind === 'sms'
        ? await this.campaigns.query(
            `SELECT COUNT(*)::int AS "n"
               FROM "notification_schema"."sms_outbox" o
              WHERE o."campaign_id" = $1 AND o."status" = 'failed'`,
            [id],
          )
        : await this.campaigns.query(
            `SELECT COUNT(*)::int AS "n"
               FROM "notification_schema"."notifications" n
              WHERE n."group_key" = $1
                AND n."data"->>'campaign_id' = $2
                AND EXISTS (
                  SELECT 1 FROM jsonb_each_text(COALESCE(n."delivery", '{}'::jsonb)) e
                   WHERE e.key = ANY($3::text[]) AND e.value = ANY($4::text[])
                )`,
            [
              this.groupKey(id),
              id,
              [...EXTERNAL_CHANNELS],
              [...UNDELIVERED_STATUSES],
            ],
          );
    return num(rows[0]?.n);
  }

  /** Keyset (`after`) + offset sahifa — id o'sish tartibida. */
  private async undeliveredRows(
    kind: CampaignReportKind,
    id: string,
    page: { after: string; limit: number; offset: number },
  ): Promise<Array<NotificationUndeliveredRow | SmsUndeliveredRow>> {
    if (kind === 'sms') {
      return this.campaigns.query(
        `SELECT o."id", o."customer_id", o."to_phone", o."last_error", o."dlr_status", o."status"
           FROM "notification_schema"."sms_outbox" o
          WHERE o."campaign_id" = $1 AND o."status" = 'failed' AND o."id" > $2
          ORDER BY o."id" ASC
          LIMIT $3 OFFSET $4`,
        [id, page.after, page.limit, page.offset],
      );
    }
    return this.campaigns.query(
      `SELECT n."id", n."recipient_id", n."recipient_role", n."delivery"
         FROM "notification_schema"."notifications" n
        WHERE n."group_key" = $1
          AND n."data"->>'campaign_id' = $2
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(COALESCE(n."delivery", '{}'::jsonb)) e
             WHERE e.key = ANY($3::text[]) AND e.value = ANY($4::text[])
          )
          AND n."id" > $5
        ORDER BY n."id" ASC
        LIMIT $6 OFFSET $7`,
      [
        this.groupKey(id),
        id,
        [...EXTERNAL_CHANNELS],
        [...UNDELIVERED_STATUSES],
        page.after,
        page.limit,
        page.offset,
      ],
    );
  }

  /** Qatorlar → ism/rol (identity) + sabab. Telefon faqat maskalangan. */
  private async toItems(
    kind: CampaignReportKind,
    rows: Array<NotificationUndeliveredRow | SmsUndeliveredRow>,
  ): Promise<UndeliveredItem[]> {
    if (kind === 'sms') {
      const smsRows = rows as SmsUndeliveredRow[];
      const names = await this.names(
        smsRows.map((row) => text(row.customer_id)).filter(Boolean),
      );
      return smsRows.map((row) => {
        const person = row.customer_id
          ? names.get(String(row.customer_id))
          : undefined;
        return {
          ref_id: String(row.id),
          recipient_id: row.customer_id ? String(row.customer_id) : null,
          name: person?.name ?? null,
          role: person?.role ?? null,
          phone: maskPhone(row.to_phone),
          failures: [
            {
              channel: NotificationChannel.SMS as string,
              status: row.dlr_status ?? row.status,
              reason: row.last_error ? maskPhonesForLog(row.last_error) : null,
            },
          ],
        };
      });
    }
    const inboxRows = rows as NotificationUndeliveredRow[];
    const names = await this.names(
      inboxRows.map((row) => String(row.recipient_id)),
    );
    return inboxRows.map((row) => {
      const delivery = row.delivery ?? {};
      const person = names.get(String(row.recipient_id));
      return {
        ref_id: String(row.id),
        recipient_id: String(row.recipient_id),
        name: person?.name ?? null,
        role: row.recipient_role ?? person?.role ?? null,
        phone: null,
        failures: EXTERNAL_CHANNELS.filter((channel) =>
          UNDELIVERED_STATUSES.includes(text(delivery[channel])),
        ).map((channel) => ({
          channel,
          status: text(delivery[channel]),
          reason:
            text(delivery[`${channel}_reason`]) ||
            text(delivery[`${channel}_error`]) ||
            null,
        })),
      };
    });
  }

  /**
   * Ism va rol — identity `find_by_ids` (rol filtrisiz, telefon QAYTMAYDI),
   * 500 tadan. Identity javob bermasa — ismsiz (hisobot ochilaveradi).
   */
  private async names(ids: string[]) {
    const unique = [...new Set(ids.filter((id) => ID_RE.test(id)))];
    const map = new Map<string, { name: string | null; role: string | null }>();
    for (let start = 0; start < unique.length; start += NAME_CHUNK) {
      try {
        const res = await rmqSend<
          | { data?: Array<{ id: unknown; name?: unknown; role?: unknown }> }
          | Array<{ id: unknown; name?: unknown; role?: unknown }>
        >(this.identityClient, FIND_BY_IDS, {
          ids: unique.slice(start, start + NAME_CHUNK),
        });
        const list = Array.isArray(res) ? res : (res?.data ?? []);
        for (const user of list) {
          map.set(text(user.id), {
            name: typeof user.name === 'string' ? user.name : null,
            role: typeof user.role === 'string' ? user.role : null,
          });
        }
      } catch (error) {
        this.logger.warn(`hisobot: ismlar olinmadi — ${shortError(error)}`);
      }
    }
    return map;
  }

  /** `GET .../undelivered` — sahifalab (ism/rol + sabab). */
  async undelivered(
    input: CampaignReportInput & { page?: unknown; limit?: unknown } = {},
  ) {
    try {
      const kind = this.kindOf(input?.kind);
      const id = this.idOf(input?.id);
      const campaign =
        kind === 'sms'
          ? await this.smsCampaign(id)
          : await this.notificationCampaign(id);
      const pageNo = Math.max(1, Math.floor(num(input?.page)) || 1);
      const limit = Math.min(
        Math.max(1, Math.floor(num(input?.limit)) || 50),
        PAGE_MAX,
      );
      const [total, rows] = await Promise.all([
        this.countUndelivered(kind, id),
        this.undeliveredRows(kind, id, {
          after: '0',
          limit,
          offset: (pageNo - 1) * limit,
        }),
      ]);
      return successRes(
        {
          kind,
          campaign_id: id,
          items: await this.toItems(kind, rows),
          meta: {
            page: pageNo,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
          unlisted_failed:
            kind === 'notification'
              ? (campaign as NotificationCampaign).failed
              : 0,
        },
        200,
        'Campaign undelivered',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  // ==================== CSV EXPORT ====================

  private filename(kind: CampaignReportKind, id: string) {
    const stamp = (toTashkentIso(new Date()) ?? '')
      .slice(0, 16)
      .replace(/[-:]/g, '')
      .replace('T', '-');
    return `kampaniya-${kind}-${id}-yetkazilmaganlar-${stamp}.csv`;
  }

  /**
   * CSV (UTF-8 BOM — Excel kirill/o'zbekchani to'g'ri ochsin). Bitta qator =
   * bitta qabul qiluvchi; bir nechta kanal — " | " bilan. Telefon faqat
   * maskalangan; IP / moliyaviy qiymat yo'q. Keyset sahifalar (1000 tadan).
   */
  async buildCsv(
    kind: CampaignReportKind,
    id: string,
  ): Promise<{ csv: string; rows: number }> {
    const lines = [CSV_HEADER.join(',')];
    let after = '0';
    let rows = 0;
    let more = true;
    while (more) {
      const page = await this.undeliveredRows(kind, id, {
        after,
        limit: EXPORT_PAGE,
        offset: 0,
      });
      if (!page.length) break;
      for (const item of await this.toItems(kind, page)) {
        lines.push(csvLine(item));
        rows += 1;
      }
      after = String(page[page.length - 1].id);
      more = page.length === EXPORT_PAGE && rows < CAMPAIGN_EXPORT_MAX_ROWS;
    }
    return { csv: CSV_BOM + lines.join(CSV_EOL) + CSV_EOL, rows };
  }

  private async logExport(
    kind: CampaignReportKind,
    id: string,
    requester: Requester | null | undefined,
    metadata: Record<string, unknown>,
  ) {
    await this.activityLog.log({
      entity_type: kind === 'sms' ? 'SmsCampaign' : 'NotificationCampaign',
      entity_id: id,
      action: ActivityAction.EXPORT,
      user_id: actorId(requester),
      user_role: actorRoles(requester).join(',') || null,
      metadata: {
        scope: 'campaign_undelivered',
        campaign_kind: kind,
        format: 'csv',
        phone: 'masked',
        ...metadata,
      },
    });
  }

  /** Muddati o'tgan tayyor fayllar matni tozalanadi (PII uzoq yotmasin). */
  private async purgeExpired() {
    try {
      await this.exports
        .createQueryBuilder()
        .update(CampaignReportExport)
        .set({ csv: null })
        .where('expires_at < now()')
        .andWhere('csv IS NOT NULL')
        .execute();
    } catch (error) {
      this.logger.warn(`eksport tozalash: ${shortError(error)}`);
    }
  }

  private jobPublic(job: CampaignReportExport) {
    return {
      export_id: String(job.id),
      campaign_kind: job.campaign_kind,
      campaign_id: String(job.campaign_id),
      status: job.status,
      rows: job.row_count,
      filename: job.filename,
      error: job.error,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      expires_at: job.expires_at,
      download_url:
        job.status === 'done'
          ? `/notifications/campaigns/exports/${job.id}/download`
          : null,
    };
  }

  /**
   * "Yetkazilmaganlar" CSV — FAQAT superadmin. ≤ 10 000 qator — darhol
   * (javobda `csv`), eksport jurnalga `export` amali bilan yoziladi. Katta —
   * SINXRON EMAS: fon vazifasi (202 `{ export_id }`), outbox orqali.
   */
  async exportUndelivered(input: CampaignReportInput = {}) {
    try {
      const kind = this.kindOf(input?.kind);
      const id = this.idOf(input?.id);
      this.assertSuperadmin(input?.requester);
      if (kind === 'sms') await this.smsCampaign(id);
      else await this.notificationCampaign(id);
      await this.purgeExpired();

      const total = await this.countUndelivered(kind, id);
      if (total > CAMPAIGN_EXPORT_MAX_ROWS) {
        throw new BadRequestException(
          `Eksport ${total} qator — chegara ${CAMPAIGN_EXPORT_MAX_ROWS}`,
        );
      }
      if (total <= CAMPAIGN_EXPORT_SYNC_MAX_ROWS) {
        const { csv, rows } = await this.buildCsv(kind, id);
        await this.logExport(kind, id, input?.requester, {
          rows,
          mode: 'sync',
        });
        return successRes(
          {
            mode: 'sync',
            rows,
            filename: this.filename(kind, id),
            content_type: CSV_CONTENT_TYPE,
            csv,
          },
          200,
          'Export ready',
        );
      }

      // Katta eksport — fon vazifasi. Ayni superadmin ayni kampaniyani
      // qayta bossa — navbatdagi vazifa qaytadi (ikkinchisi ochilmaydi).
      const requestedBy = actorId(input?.requester);
      const active = await this.exports.findOne({
        where: {
          campaign_kind: kind,
          campaign_id: id,
          requested_by: requestedBy ?? IsNull(),
          status: In(['queued', 'running']),
        },
        order: { id: 'DESC' },
      });
      if (active) {
        return successRes(
          { ...this.jobPublic(active), mode: 'async', duplicate: true },
          202,
          'Export already queued',
        );
      }
      const job = await this.exports.manager.transaction(async (manager) => {
        const repo = manager.getRepository(CampaignReportExport);
        const saved = await repo.save(
          repo.create({
            campaign_kind: kind,
            campaign_id: id,
            requested_by: requestedBy,
            requested_role: actorRoles(input?.requester).join(',') || null,
            status: 'queued',
            row_count: total,
          }),
        );
        await this.outbox.enqueue(
          'NOTIFICATION',
          CAMPAIGN_EXPORT_RUN_PATTERN,
          { export_id: String(saved.id) },
          { manager, requestId: `campaign-export:${saved.id}` },
        );
        return saved;
      });
      return successRes(
        {
          ...this.jobPublic(job),
          mode: 'async',
          duplicate: false,
          sync_limit: CAMPAIGN_EXPORT_SYNC_MAX_ROWS,
        },
        202,
        'Export queued',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Outbox iste'molchisi: vazifani DA'VO qiladi (queued → running; uzilgan
   * `running` 10 daqiqadan keyin qayta olinadi) va CSV'ni FONDA yig'adi —
   * outbox publisher (20 s javob muddati) katta eksportni kutib turmaydi.
   * Qayta yetkazilgan xabar ikkinchi marta yig'maydi.
   */
  async runExport(payload: { export_id?: unknown } = {}) {
    const id = text(payload?.export_id).trim();
    if (!ID_RE.test(id)) return { export_id: null, skipped: 'bad_payload' };
    const staleBefore = new Date(Date.now() - EXPORT_STALE_MS);
    const res = await this.exports
      .createQueryBuilder()
      .update(CampaignReportExport)
      .set({
        status: 'running',
        started_at: () => 'now()',
        attempts: () => '"attempts" + 1',
        error: null,
      })
      .where('id = :id', { id })
      .andWhere(
        `(status = 'queued' OR (status = 'running' AND started_at < :staleBefore))`,
        { staleBefore },
      )
      .execute();
    if (!res.affected) return { export_id: id, skipped: 'not_queued' };
    const job = await this.exports.findOne({ where: { id } });
    if (!job) return { export_id: id, skipped: 'not_found' };
    const work = this.build(job).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return { export_id: id, status: 'running' };
  }

  /** Fondagi yig'ish tugashini kutish (test / graceful). */
  settled(exportId: string): Promise<void> {
    return this.inflight.get(String(exportId)) ?? Promise.resolve();
  }

  private async build(job: CampaignReportExport): Promise<void> {
    try {
      const { csv, rows } = await this.buildCsv(
        job.campaign_kind,
        String(job.campaign_id),
      );
      const now = Date.now();
      await this.exports.update(
        { id: job.id, status: 'running' },
        {
          status: 'done',
          csv,
          row_count: rows,
          filename: this.filename(job.campaign_kind, String(job.campaign_id)),
          error: null,
          finished_at: new Date(now),
          expires_at: new Date(now + CAMPAIGN_EXPORT_TTL_MS),
        },
      );
    } catch (error) {
      this.logger.warn(`eksport ${job.id} yiqildi: ${shortError(error)}`);
      await this.exports
        .update(
          { id: job.id },
          {
            status: 'failed',
            error: shortError(error),
            finished_at: new Date(),
          },
        )
        .catch(() => undefined);
    }
  }

  private async loadJob(raw: unknown, requester: Requester | null | undefined) {
    this.assertSuperadmin(requester);
    const id = this.idOf(raw, 'export_id');
    const job = await this.exports.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Eksport topilmadi');
    // Jarayon uzilgan (servis qayta ishga tushgan) — abadiy "running" emas.
    if (
      job.status === 'running' &&
      job.started_at &&
      new Date(job.started_at).getTime() < Date.now() - EXPORT_STALE_MS &&
      !this.inflight.has(String(job.id))
    ) {
      await this.exports.update(
        { id: job.id, status: 'running' },
        {
          status: 'failed',
          error: "Eksport jarayoni uzildi — qaytadan so'rang",
          finished_at: new Date(),
        },
      );
      return (await this.exports.findOne({ where: { id } })) ?? job;
    }
    return job;
  }

  /** `GET /notifications/campaigns/exports/:id` — holat (superadmin). */
  async getExport(
    input: { export_id?: unknown; requester?: Requester | null } = {},
  ) {
    try {
      const job = await this.loadJob(input?.export_id, input?.requester);
      return successRes(this.jobPublic(job), 200, 'Campaign export');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Tayyor faylni yuklab olish (superadmin). Har yuklash — ma'lumot tizimdan
   * chiqishi: faoliyat jurnaliga `export` amali yoziladi.
   */
  async downloadExport(
    input: { export_id?: unknown; requester?: Requester | null } = {},
  ) {
    try {
      const job = await this.loadJob(input?.export_id, input?.requester);
      if (job.status !== 'done') {
        throw new ConflictException(`Eksport hali tayyor emas (${job.status})`);
      }
      if (
        !job.csv ||
        (job.expires_at && new Date(job.expires_at).getTime() < Date.now())
      ) {
        throw new GoneException(
          "Eksport fayli muddati o'tgan — qaytadan eksport qiling",
        );
      }
      await this.logExport(
        job.campaign_kind,
        String(job.campaign_id),
        input?.requester,
        { rows: job.row_count, mode: 'async', export_id: String(job.id) },
      );
      return successRes(
        {
          mode: 'file',
          export_id: String(job.id),
          rows: job.row_count,
          filename:
            job.filename ??
            this.filename(job.campaign_kind, String(job.campaign_id)),
          content_type: CSV_CONTENT_TYPE,
          csv: job.csv,
        },
        200,
        'Export file',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
