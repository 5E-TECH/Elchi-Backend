import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { randomUUID } from 'crypto';
import {
  endOfTashkentDay,
  startOfTashkentDay,
  tashkentDayRange,
} from '@app/common';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { Notification } from '../entities/notification.entity';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';
import {
  SmsBlockedError,
  SmsGateService,
  SmsQuotaStream,
  smsQuotaStream,
} from './sms-gate.service';
import { countSmsSegments } from './sms-segments.util';
import { maskPhone, normalizeSmsPhone } from './sms-phone.util';
import {
  SMS_DLR_FINAL_FAILURES,
  SmsDeliveryReport,
  SmsMessageClass,
  SmsSenderProfile,
} from './sms.port';

export interface EnqueueSmsInput {
  to: string;
  customerId?: string | null;
  text: string;
  messageClass: SmsMessageClass;
  templateCode?: string | null;
  notificationId?: string | null;
  campaignId?: string | null;
  /** BIZNING id (DLR moslash va takrorni to'sish). Berilmasa UUID. */
  clientMessageId?: string;
  senderProfile?: SmsSenderProfile;
}

export interface EnqueueSmsResult {
  queued: Array<{
    id: string;
    to: string;
    client_message_id: string;
    scheduled_at: Date;
    parts: number;
    cost: number | null;
  }>;
  skipped: Array<{ to: string; reason: 'invalid_phone' }>;
  /** Jami prognoz narx; birorta qator tarifsiz bo'lsa null ("tarif sozlanmagan"). */
  estimated_cost: number | null;
}

/** Bir xil client_message_id ikkinchi marta — DB constraint rad etdi. */
export class SmsDuplicateError extends Error {
  constructor(readonly clientMessageIds: string[]) {
    super('Bu SMS allaqachon navbatda (client_message_id takror)');
    this.name = 'SmsDuplicateError';
  }
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Shu muddatdan uzoq `processing` da turgan qator — jarayon qulagan, qayta navbatga. */
const STUCK_PROCESSING_MS = 15 * 60_000;
const INSERT_CHUNK = 500;
/**
 * Kunlik kvota qulfi (3fRbyadQ #5). Scheduler qulfi
 * (`notification.sms-outbox.tick`) va integration-service qulfidan BOSHQA nom.
 */
export const SMS_QUOTA_LOCK_NAME = 'notification.sms-outbox.quota';
/**
 * (rkz0yBxr) OTP oqimining ALOHIDA kvota qulfi: katta reklama/tranzaksion
 * INSERT umumiy qulfni ushlab turganda ham login kodi kutib qolmaydi.
 */
export const SMS_OTP_QUOTA_LOCK_NAME = 'notification.sms-outbox.quota.otp';
const QUOTA_LOCKS: Record<SmsQuotaStream, string> = {
  general: SMS_QUOTA_LOCK_NAME,
  otp: SMS_OTP_QUOTA_LOCK_NAME,
};
/** Qulf olish tartibi doim bir xil (deadlock bo'lmasin). */
const QUOTA_STREAM_ORDER: SmsQuotaStream[] = ['general', 'otp'];
const MAX_ERROR = 500;

/**
 * Xarajat hisobotidagi Toshkent kuni — SMS modulida `AT TIME ZONE` FAQAT shu
 * yerda. Kvota va tungi taqiq esa umumiy `@app/common` qoidasi orqali.
 *
 * (8auPBa1O TC11) Kun MATN sifatida qaytadi ('YYYY-MM-DD'): `::date` ni
 * node-pg JS Date'ga (server TZ yarim tuni) aylantirardi, keyingi
 * `toISOString()` esa UTC'ga qaytarib — TZ=Asia/Tashkent serverda har kun
 * bitta oldingi sanaga tushardi (qo'shaloq konversiya).
 */
const SMS_TASHKENT_DAY_SQL = `to_char(o."created_at" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD')`;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Xarajat hisoboti oralig'i (8auPBa1O #6, TC11) — `[from, to)`, Toshkent kuni:
 * - 'YYYY-MM-DD' → o'sha Toshkent kunining boshi / (to uchun) kun OXIRIGACHA
 *   kiradi — `new Date('2026-10-01')` (UTC yarim tuni = Toshkent 05:00) EMAS;
 * - to'liq ISO (zona bilan) → o'zgarishsiz lahza;
 * - berilmasa: bugungi Toshkent kuni bilan tugaydigan oxirgi 30 kun.
 * Yaroqsiz qiymat → null (chaqiruvchi 400 qaytaradi).
 */
export const smsReportRange = (
  rawFrom: string | null | undefined,
  rawTo: string | null | undefined,
  now = new Date(),
): { from: Date; to: Date } | null => {
  const range = tashkentDayRange(rawFrom || null, rawTo || null);
  const to = range.end
    ? DATE_ONLY_RE.test(String(rawTo).trim())
      ? new Date(range.end.getTime() + 1)
      : range.end
    : new Date(endOfTashkentDay(now).getTime() + 1);
  const from =
    range.start ?? startOfTashkentDay(new Date(to.getTime() - 30 * DAY_MS));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)
    return null;
  return { from, to };
};

/** OTP kodi DB'da yuborilgandan keyin qolmasin (rkz0yBxr: ochiq kod hech qayerda). */
const redactSecurity = (row: SmsOutbox) =>
  row.message_class === 'security'
    ? { text: row.text.replace(/\d{4,8}/g, '******') }
    : {};

const backoffMs = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/**
 * SMS navbati (3fRbyadQ): navbatga qo'yish, yuborish uchun egallash, natija,
 * DLR (8auPBa1O) va xarajat hisoboti.
 */
@Injectable()
export class SmsOutboxService {
  private readonly logger = new Logger(SmsOutboxService.name);

  constructor(
    @InjectRepository(SmsOutbox)
    private readonly repo: Repository<SmsOutbox>,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly dataSource: DataSource,
    private readonly config: SmsConfigService,
    private readonly gate: SmsGateService,
    private readonly consent: SmsConsentService,
  ) {}

  /**
   * Darvozadan o'tkazib navbatga qo'yadi. Darvoza rad etsa `SmsBlockedError`
   * (hech qanday qator yozilmaydi), takror bo'lsa `SmsDuplicateError`.
   * Promo roziligi shu chegarada ham tekshiriladi — boshqa chaqiruvchilar
   * kampaniya tekshiruvini chetlab o'tolmaydi.
   */
  async enqueue(
    inputs: EnqueueSmsInput[],
    options: { manager?: EntityManager; now?: Date } = {},
  ): Promise<EnqueueSmsResult> {
    const now = options.now ?? new Date();
    const skipped: EnqueueSmsResult['skipped'] = [];
    const valid: Array<EnqueueSmsInput & { to: string }> = [];
    for (const input of inputs) {
      const to = normalizeSmsPhone(input.to);
      if (!to)
        skipped.push({ to: maskPhone(input.to), reason: 'invalid_phone' });
      else valid.push({ ...input, to });
    }
    if (!valid.length) return { queued: [], skipped, estimated_cost: 0 };

    const promo = valid.filter((input) => input.messageClass === 'promo');
    if (promo.length) {
      const { blocked } = await this.consent.partition(
        promo.map((input) => ({
          phone: input.to,
          customer_id: input.customerId ?? null,
        })),
        now,
      );
      if (blocked.length) {
        throw new SmsBlockedError(
          'no_consent',
          `Reklama SMS uchun rozilik yo'q (${blocked.length} ta raqam)`,
          { blocked: blocked.length },
        );
      }
    }

    // Kill-switch va fan-out — qulfsiz, arzon tekshiruv (kvota qulf ichida qayta).
    this.gate.assertEnabledAndFanout(valid.length);

    const rows = valid.map((input) => {
      let text = input.text;
      if (input.messageClass === 'promo') {
        const withOptOut = this.consent.appendOptOut(text, input.to);
        if (withOptOut === null) {
          throw new SmsBlockedError(
            'opt_out_not_configured',
            'Reklama SMS uchun bekor qilish havolasi sozlanmagan (SMS_OPT_OUT_BASE_URL, SMS_DLR_SECRET) — reklama yuborilmaydi',
          );
        }
        text = withOptOut;
      }
      const segments = countSmsSegments(text);
      const cost = this.config.cost(input.messageClass, segments.parts);
      return {
        to_phone: input.to,
        customer_id: input.customerId ?? null,
        text,
        message_class: input.messageClass,
        template_code: input.templateCode ?? null,
        parts: segments.parts,
        encoding: segments.encoding,
        provider: this.config.provider,
        sender_profile: input.senderProfile ?? 'default',
        client_message_id: input.clientMessageId ?? randomUUID(),
        cost: cost === null ? null : cost.toFixed(2),
        notification_id: input.notificationId ?? null,
        campaign_id: input.campaignId ?? null,
        scheduled_at: this.gate.scheduleFor(input.messageClass, now),
        status: 'pending' as const,
        attempts: 0,
        retry_count: 0,
        max_attempts: 3,
      };
    });

    // (3fRbyadQ #5) Kvota FAIL-CLOSED va POYGASIZ: sanash + INSERT bitta
    // tranzaksiyada, global advisory xact-lock ostida. Qulfsiz ikki parallel
    // dispatch ikkalasi ham "bugun 490/500" ni ko'rib, birgalikda kvotadan
    // oshib ketardi (pul). Qulf COMMIT/ROLLBACK da o'zi bo'shaydi; chaqiruvchi
    // tranzaksiyasi (`manager`) bo'lsa — o'sha tranzaksiya oxirigacha turadi.
    // (rkz0yBxr) Har oqim — o'z qulfi va o'z kvotasi (OTP reklama bilan umumiy EMAS).
    const perStream = new Map<SmsQuotaStream, number>();
    for (const input of valid) {
      const stream = smsQuotaStream(input.messageClass);
      perStream.set(stream, (perStream.get(stream) ?? 0) + 1);
    }
    const write = async (manager: EntityManager): Promise<string[]> => {
      for (const stream of QUOTA_STREAM_ORDER) {
        const count = perStream.get(stream);
        if (!count) continue;
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          QUOTA_LOCKS[stream],
        ]);
        await this.gate.assertCanEnqueue(count, now, manager, stream);
      }
      const repo = manager.getRepository(SmsOutbox);
      const ids: string[] = [];
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        const result = await repo.insert(
          rows.slice(start, start + INSERT_CHUNK),
        );
        ids.push(
          ...result.identifiers.map((identifier) => String(identifier.id)),
        );
      }
      return ids;
    };
    let ids: string[];
    try {
      ids = options.manager
        ? await write(options.manager)
        : await this.dataSource.transaction(write);
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new SmsDuplicateError(rows.map((row) => row.client_message_id));
      }
      throw error;
    }

    const costs = rows.map((row) =>
      row.cost === null ? null : Number(row.cost),
    );
    return {
      queued: rows.map((row, index) => ({
        id: ids[index],
        to: row.to_phone,
        client_message_id: row.client_message_id,
        scheduled_at: row.scheduled_at,
        parts: row.parts,
        cost: costs[index],
      })),
      skipped,
      estimated_cost: costs.some((cost) => cost === null)
        ? null
        : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    };
  }

  /**
   * Yuborish uchun qatorlarni EGALLAYDI: `FOR UPDATE SKIP LOCKED` — ikkita
   * nusxa bir qatorni ikki marta ololmaydi (advisory lock bilan birga).
   * (rkz0yBxr) OTP (`security`) ALOHIDA oqim — navbat boshiga: minglab
   * reklama qatori kutib turgan bo'lsa ham login kodi keyingi tikda ketadi.
   */
  async claimDue(limit: number, now = new Date()): Promise<SmsOutbox[]> {
    await this.recoverStuck(now);
    const rows: SmsOutbox[] = await this.dataSource.query(
      `UPDATE "notification_schema"."sms_outbox" o
          SET "status" = 'processing', "updated_at" = NOW()
        WHERE o."id" IN (
          SELECT "id" FROM "notification_schema"."sms_outbox"
           WHERE "status" = 'pending'
             AND "scheduled_at" <= $1
             AND ("next_retry_at" IS NULL OR "next_retry_at" <= $1)
           ORDER BY ("message_class" = 'security') DESC, "scheduled_at" ASC, "id" ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING o.*`,
      [now, limit],
    );
    return Array.isArray(rows[0]) ? (rows[0] as SmsOutbox[]) : rows;
  }

  /**
   * Jarayon qulab `processing` da qolgan qatorlar — qayta navbatga.
   * (3fRbyadQ TC10) Bu ham URINISH hisoblanadi: provayder SMS'ni qabul qilgan
   * bo'lishi mumkin (javobni yozishga ulgurmay qulagan), shuning uchun
   * `max_attempts` ga yetgan qator CHEKSIZ qayta yuborilmaydi — terminal
   * `failed`. Aks holda har qulashda bitta SMS yana va yana ketardi.
   */
  private async recoverStuck(now: Date) {
    const result: unknown = await this.dataSource.query(
      `UPDATE "notification_schema"."sms_outbox"
          SET "attempts" = "attempts" + 1,
              "status" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN 'failed' ELSE 'pending' END,
              "retry_count" = CASE WHEN "attempts" + 1 >= "max_attempts" THEN "retry_count" ELSE "retry_count" + 1 END,
              "next_retry_at" = NULL,
              "text" = CASE WHEN "message_class" = 'security' AND "attempts" + 1 >= "max_attempts"
                            THEN regexp_replace("text", '\\d{4,8}', '******', 'g') ELSE "text" END,
              "last_error" = 'recovered: processing timed out',
              "updated_at" = NOW()
        WHERE "status" = 'processing' AND "updated_at" < $1`,
      [new Date(now.getTime() - STUCK_PROCESSING_MS)],
    );
    const affected = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    if (affected)
      this.logger.warn(
        `SMS: ${affected} ta qotgan 'processing' qator qayta navbatga qo'yildi`,
      );
  }

  /**
   * Egallangan, lekin YUBORILMAGAN qatorlarni qaytaradi (graceful shutdown,
   * 3fRbyadQ TC11): urinish SARFLANMAYDI — provayderga hech narsa ketmagan.
   * Faqat `processing` dagilar (boshqa holatga o'tganini qaytarmaydi).
   */
  async releaseClaimed(ids: string[]) {
    if (!ids.length) return;
    await this.dataSource.query(
      `UPDATE "notification_schema"."sms_outbox"
          SET "status" = 'pending', "updated_at" = NOW()
        WHERE "id" = ANY($1::bigint[]) AND "status" = 'processing'`,
      [ids],
    );
  }

  /**
   * (sVByLMnt #3) Yuborish paytida tungi taqiqqa tushgan reklama — taqiq
   * tugashiga suriladi: urinish SARFLANMAYDI, qator tashlanmaydi.
   */
  async deferUntil(id: string, until: Date) {
    await this.dataSource.query(
      `UPDATE "notification_schema"."sms_outbox"
          SET "status" = 'pending', "scheduled_at" = $2, "updated_at" = NOW()
        WHERE "id" = $1 AND "status" = 'processing'`,
      [id, until],
    );
  }

  async markAccepted(
    row: SmsOutbox,
    providerMessageId: string | null,
    raw: unknown,
    now = new Date(),
  ) {
    await this.repo.update(
      { id: row.id },
      {
        status: 'sent',
        ...redactSecurity(row),
        provider_message_id: providerMessageId,
        sent_at: now,
        attempts: row.attempts + 1,
        last_error: null,
        last_response: this.compact(raw),
        next_retry_at: null,
      },
    );
    await this.patchNotification(row.notification_id, { sms: 'accepted' });
  }

  /**
   * Xato: `retryable` bo'lsa backoff bilan qayta urinish; `max_attempts` ga
   * yetganda (yoki qayta urinib bo'lmas xato) — TERMINAL `failed`.
   */
  async markFailed(
    row: SmsOutbox,
    error: string,
    retryable: boolean,
    raw: unknown = null,
    now = new Date(),
  ) {
    const attempts = row.attempts + 1;
    const terminal = !retryable || attempts >= row.max_attempts;
    await this.repo.update(
      { id: row.id },
      {
        status: terminal ? 'failed' : 'pending',
        ...(terminal ? redactSecurity(row) : {}),
        attempts,
        retry_count: terminal ? row.retry_count : row.retry_count + 1,
        last_error: error.slice(0, MAX_ERROR),
        last_response: this.compact(raw),
        next_retry_at: terminal
          ? null
          : new Date(now.getTime() + backoffMs(attempts)),
      },
    );
    if (terminal) {
      await this.patchNotification(row.notification_id, {
        sms: 'failed',
        sms_error: error.slice(0, MAX_ERROR),
      });
    }
    return terminal;
  }

  /**
   * DLR (8auPBa1O #4): BIZNING client_message_id bo'yicha moslanadi —
   * provayder id'siga tayanilmaydi. 'delivered' → delivery.sms='sent';
   * yakuniy rad (not_delivered/rejected/failed/expired) → 'failed', 'sent' emas.
   */
  async applyDeliveryReport(report: SmsDeliveryReport): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { client_message_id: report.clientMessageId },
    });
    if (!row) return false;
    const failed = SMS_DLR_FINAL_FAILURES.includes(report.status);
    const delivered = report.status === 'delivered';
    await this.repo.update(
      { id: row.id },
      {
        dlr_status: report.status,
        dlr_at: report.at,
        ...(delivered ? { status: 'delivered' as const } : {}),
        ...(failed
          ? {
              status: 'failed' as const,
              last_error: `DLR: ${report.providerStatus}`,
            }
          : {}),
      },
    );
    if (delivered)
      await this.patchNotification(row.notification_id, { sms: 'sent' });
    if (failed) {
      await this.patchNotification(row.notification_id, {
        sms: 'failed',
        sms_error: `DLR: ${report.providerStatus}`,
      });
    }
    return true;
  }

  /** delivery JSONB'ga birlashtiradi (logga emas, DB'ga). */
  async patchNotification(
    notificationId: string | null,
    patch: Record<string, unknown>,
  ) {
    if (!notificationId) return;
    await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds([notificationId])
      .execute();
  }

  async patchNotifications(ids: string[], patch: Record<string, unknown>) {
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
   * Xarajat hisoboti (8auPBa1O #6): Toshkent kuni × sinf kesimida soni, yetkazilgan,
   * xato, so'm. Tarifsiz qatorlar alohida sanaladi ("tarif sozlanmagan").
   */
  async costReport(from: Date, to: Date) {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${SMS_TASHKENT_DAY_SQL} AS "day",
              o."message_class" AS "message_class",
              COUNT(*)::int AS "total",
              COUNT(*) FILTER (WHERE o."status" = 'delivered')::int AS "delivered",
              COUNT(*) FILTER (WHERE o."status" = 'failed')::int AS "failed",
              COALESCE(SUM(o."parts"), 0)::int AS "parts",
              COALESCE(SUM(o."cost"), 0)::numeric AS "cost",
              COUNT(*) FILTER (WHERE o."cost" IS NULL)::int AS "untariffed"
         FROM "notification_schema"."sms_outbox" o
        WHERE o."created_at" >= $1 AND o."created_at" < $2
        GROUP BY 1, 2
        ORDER BY 1 ASC, 2 ASC`,
      [from, to],
    );
    const days = rows.map((row) => ({
      day: String(row.day),
      message_class: String(row.message_class),
      total: Number(row.total),
      delivered: Number(row.delivered),
      failed: Number(row.failed),
      parts: Number(row.parts),
      cost: Number(row.cost),
      untariffed: Number(row.untariffed),
    }));
    const totals = days.reduce(
      (acc, row) => ({
        total: acc.total + row.total,
        delivered: acc.delivered + row.delivered,
        failed: acc.failed + row.failed,
        parts: acc.parts + row.parts,
        cost: acc.cost + row.cost,
        untariffed: acc.untariffed + row.untariffed,
      }),
      { total: 0, delivered: 0, failed: 0, parts: 0, cost: 0, untariffed: 0 },
    );
    // Oylik va sinf kesimidagi yig'indi (8auPBa1O #6) — kunlik qatorlardan.
    const months = this.rollup(days, (row) => row.day.slice(0, 7), 'month');
    const byClass = this.rollup(
      days,
      (row) => row.message_class,
      'message_class',
    );
    const finished = totals.delivered + totals.failed;
    return {
      days,
      months,
      by_class: byClass,
      totals: {
        ...totals,
        success_rate: finished
          ? Math.round((totals.delivered / finished) * 1000) / 10
          : null,
        tariff_configured:
          this.config.tariff('transactional') !== null &&
          this.config.tariff('promo') !== null,
      },
    };
  }

  private rollup<K extends string>(
    days: Array<{
      day: string;
      message_class: string;
      total: number;
      delivered: number;
      failed: number;
      parts: number;
      cost: number;
      untariffed: number;
    }>,
    keyOf: (row: (typeof days)[number]) => string,
    label: K,
  ) {
    const groups = new Map<string, Record<string, number>>();
    for (const row of days) {
      const key = keyOf(row);
      const acc = groups.get(key) ?? {
        total: 0,
        delivered: 0,
        failed: 0,
        parts: 0,
        cost: 0,
        untariffed: 0,
      };
      for (const field of [
        'total',
        'delivered',
        'failed',
        'parts',
        'cost',
        'untariffed',
      ] as const)
        acc[field] += row[field];
      groups.set(key, acc);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, values]) =>
          ({ [label]: key, ...values }) as Record<K, string> &
            Record<string, number | string>,
      );
  }

  /**
   * (2026-10-26) Bekor qilingan bildirishnoma kampaniyasining (`campaign:<id>`
   * guruhi) hali yuborilmagan — `pending` — SMS qatorlari terminal holatga
   * o'tadi (sms_outbox CHECK'ida `cancelled` yo'q → `failed`,
   * `last_error = 'cancelled: campaign cancelled'`), bildirishnoma
   * `delivery.sms = 'skipped'` (`sms_reason: 'campaign_cancelled'`).
   * `processing` (provayderga ketayotgan) va yuborilganlarga tegilmaydi.
   * Qaytadi — to'xtatilgan SMS soni.
   */
  async cancelPendingForNotificationCampaign(
    campaignId: string,
  ): Promise<number> {
    const id = String(campaignId);
    const result: unknown = await this.dataSource.query(
      `WITH cancelled AS (
         UPDATE "notification_schema"."sms_outbox" o
            SET "status" = 'failed',
                "next_retry_at" = NULL,
                "last_error" = 'cancelled: campaign cancelled',
                "updated_at" = NOW()
           FROM "notification_schema"."notifications" n
          WHERE n."group_key" = $1
            AND n."data"->>'campaign_id' = $2
            AND o."notification_id" = n."id"
            AND o."status" = 'pending'
         RETURNING o."notification_id"
       ),
       patched AS (
         UPDATE "notification_schema"."notifications" n
            SET "delivery" = COALESCE(n."delivery", '{}'::jsonb) || $3::jsonb
          WHERE n."id" IN (SELECT "notification_id" FROM cancelled)
         RETURNING n."id"
       )
       SELECT COUNT(*)::int AS "n" FROM cancelled`,
      [
        `campaign:${id}`,
        id,
        JSON.stringify({ sms: 'skipped', sms_reason: 'campaign_cancelled' }),
      ],
    );
    const rows = Array.isArray(result)
      ? (result as Array<{ n?: unknown }>)
      : [];
    const count = Number(rows[0]?.n ?? 0);
    if (count) {
      this.logger.log(
        `SMS: kampaniya ${id} bekor qilindi — ${count} ta kutayotgan SMS to'xtatildi`,
      );
    }
    return count;
  }

  async countByCampaign(campaignIds: string[]) {
    if (!campaignIds.length) return new Map<string, Record<string, number>>();
    const rows: Array<{ campaign_id: string; status: string; n: number }> =
      await this.repo
        .createQueryBuilder('o')
        .select('o.campaign_id', 'campaign_id')
        .addSelect('o.status', 'status')
        .addSelect('COUNT(*)::int', 'n')
        .where({ campaign_id: In(campaignIds) })
        .groupBy('o.campaign_id')
        .addGroupBy('o.status')
        .getRawMany();
    const map = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const key = String(row.campaign_id);
      map.set(key, { ...(map.get(key) ?? {}), [row.status]: Number(row.n) });
    }
    return map;
  }

  /** jsonb ustuni — TypeORM deep-partial turiga sig'maydi, shuning uchun cast. */
  private compact(
    raw: unknown,
  ): QueryDeepPartialEntity<SmsOutbox>['last_response'] {
    if (raw === null || raw === undefined) return null;
    const json = JSON.stringify(raw);
    return (
      json.length > 2000 ? { truncated: json.slice(0, 2000) } : raw
    ) as QueryDeepPartialEntity<SmsOutbox>['last_response'];
  }
}
