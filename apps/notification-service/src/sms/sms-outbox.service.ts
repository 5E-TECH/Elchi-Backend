import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { randomUUID } from 'crypto';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { Notification } from '../entities/notification.entity';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';
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
const MAX_ERROR = 500;

/**
 * Xarajat hisobotidagi Toshkent kuni — SMS modulida `AT TIME ZONE` FAQAT shu
 * yerda. Kvota va tungi taqiq esa umumiy `@app/common` qoidasi orqali.
 */
const SMS_TASHKENT_DAY_SQL = `(o."created_at" AT TIME ZONE 'Asia/Tashkent')::date`;

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
   * Rozilik tekshiruvi CHAQIRUVCHIDA (kampaniya) — bu yerda faqat opt-out matni.
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

    await this.gate.assertCanEnqueue(valid.length, now);

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

    const repo = options.manager
      ? options.manager.getRepository(SmsOutbox)
      : this.repo;
    const ids: string[] = [];
    try {
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        const result = await repo.insert(
          rows.slice(start, start + INSERT_CHUNK),
        );
        ids.push(
          ...result.identifiers.map((identifier) => String(identifier.id)),
        );
      }
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
           ORDER BY "scheduled_at" ASC, "id" ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING o.*`,
      [now, limit],
    );
    return Array.isArray(rows[0]) ? (rows[0] as SmsOutbox[]) : rows;
  }

  /** Jarayon qulab `processing` da qolgan qatorlar — qayta navbatga. */
  private async recoverStuck(now: Date) {
    const result: unknown = await this.dataSource.query(
      `UPDATE "notification_schema"."sms_outbox"
          SET "status" = 'pending', "last_error" = 'recovered: processing timed out', "updated_at" = NOW()
        WHERE "status" = 'processing' AND "updated_at" < $1`,
      [new Date(now.getTime() - STUCK_PROCESSING_MS)],
    );
    const affected = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    if (affected)
      this.logger.warn(
        `SMS: ${affected} ta qotgan 'processing' qator qayta navbatga qo'yildi`,
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
      day:
        row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day).slice(0, 10),
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
    const finished = totals.delivered + totals.failed;
    return {
      days,
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
