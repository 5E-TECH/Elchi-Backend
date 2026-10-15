import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  pickAuditActor,
  pickAuditContext,
  requestContext,
} from '../context/request-context';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';
import { quoteActivityLogTable } from './retention';
import {
  ACTIVITY_LOG_ARCHIVE_TABLE,
  ActivityLogRetentionPolicy,
  activityLogArchiveExists,
  countByRule,
  isActivityLogArchiveEnabled,
  pruneByRuleBatched,
  resolveActivityLogRetentionPolicy,
  resolvePruneBatchSize,
  resolvePrunePauseMs,
} from './retention-policy';
import { ACTIVITY_LOG_SERVICE_NAME, ActivityLogInput } from './types';

export interface ActivityLogPruneReport {
  service: string | null;
  dryRun: boolean;
  rules: Array<{
    name: string;
    days: number;
    count: number;
    batches: number;
    /** i6Nyedea — arxivga ko'chirilgan qatorlar (faqat ko'chirish rejimida). */
    archived?: number;
  }>;
  warnings: string[];
  /**
   * i6Nyedea arxiv holati: `enabled` — `ACTIVITY_LOG_PRUNE_ARCHIVE` (sukut
   * yoqiq), `ready` — arxiv jadvali bor (dry-run'da ham tekshiriladi:
   * bayroqni yoqishdan oldin ko'rinsin).
   */
  archive: { enabled: boolean; table: string; ready: boolean | null };
}

/** `ACTIVITY_LOG_LOGIN_DEDUP_MINUTES` — sukut 10 daqiqa; `0` — o'chiq. */
export const ACTIVITY_LOG_LOGIN_DEDUP_MINUTES_ENV =
  'ACTIVITY_LOG_LOGIN_DEDUP_MINUTES';
export const ACTIVITY_LOG_LOGIN_DEDUP_MINUTES_DEFAULT = 10;

export function resolveLoginDedupWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ACTIVITY_LOG_LOGIN_DEDUP_MINUTES_ENV];
  if (raw === undefined || raw.trim() === '') {
    return ACTIVITY_LOG_LOGIN_DEDUP_MINUTES_DEFAULT * 60_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? Math.floor(n * 60_000)
    : ACTIVITY_LOG_LOGIN_DEDUP_MINUTES_DEFAULT * 60_000;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * i6Nyedea — jurnal jadvalini jilovlash: saqlash muddati siyosati va
 * takroriy hodisalarni birlashtirish. `ActivityLogService` dan ALOHIDA
 * (yozish yo'li o'zgarmaydi), `ActivityLogModule.forService` beradi.
 */
@Injectable()
export class ActivityLogMaintenanceService {
  private readonly logger = new Logger(ActivityLogMaintenanceService.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: Repository<ActivityLog>,
    private readonly activityLog: ActivityLogService,
    @Optional()
    @Inject(ACTIVITY_LOG_SERVICE_NAME)
    private readonly serviceName: string | null = null,
  ) {}

  /**
   * Fe'l sinfiga qarab saqlash muddati (`retention-policy.ts`).
   *
   * `dryRun: true` — HECH NARSA o'chirilmaydi: har qoida bo'yicha
   * o'chiriladigan qatorlar faqat SANALADI. `false` — PARTIYALAB DELETE
   * (har partiya alohida qisqa so'rov + pauza). Natija chaqiruvchiga
   * qaytadi — u TIZIM log'iga yozadi, `activity_logs` ga EMAS (jadval
   * o'zini o'zi to'ldirmasin). Xato — yuqoriga (monitoringga chiqarish
   * chaqiruvchining ishi, jim yutilmaydi).
   *
   * i6Nyedea ARXIV (sukut yoqiq, `ACTIVITY_LOG_PRUNE_ARCHIVE`): o'chirish
   * o'rniga KO'CHIRISH — AYNI sxemadagi `activity_logs_archive` ga, har
   * partiya bitta SQL buyrug'ida (DELETE + INSERT birga). Arxiv jadvali
   * yo'q bo'lsa — HECH NARSA o'chirilmaydi, xato yuqoriga (monitoring).
   */
  async pruneByPolicy(opts: {
    dryRun: boolean;
    policy?: ActivityLogRetentionPolicy;
    batchSize?: number;
    pauseMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Berilmasa — `isActivityLogArchiveEnabled()` (sukut `true`). */
    archive?: boolean;
  }): Promise<ActivityLogPruneReport> {
    const policy = opts.policy ?? resolveActivityLogRetentionPolicy();
    const { schema, tableName } = this.repo.metadata;
    const table = quoteActivityLogTable(schema, tableName);
    const archiveTable = quoteActivityLogTable(
      schema,
      ACTIVITY_LOG_ARCHIVE_TABLE,
    );
    const run = (sql: string, params: unknown[]): Promise<unknown> =>
      this.repo.query(sql, params);
    const archiveEnabled = opts.archive ?? isActivityLogArchiveEnabled();
    const archive: ActivityLogPruneReport['archive'] = {
      enabled: archiveEnabled,
      table: archiveTable,
      ready: archiveEnabled
        ? await activityLogArchiveExists(run, archiveTable)
        : null,
    };
    if (!opts.dryRun && archiveEnabled && !archive.ready) {
      throw new Error(
        `activity_logs arxiv jadvali yo'q (${archiveTable}) — migratsiya 1716000000101 ishlamagan; ` +
          `hech qanday qator o'chirilmadi (arxivsiz o'chirish uchun ACTIVITY_LOG_PRUNE_ARCHIVE=false)`,
      );
    }
    const rules: ActivityLogPruneReport['rules'] = [];
    for (const rule of policy.rules) {
      if (opts.dryRun) {
        rules.push({
          name: rule.name,
          days: rule.days,
          count: await countByRule(run, table, rule),
          batches: 0,
        });
        continue;
      }
      const res = await pruneByRuleBatched(run, table, rule, {
        batchSize: opts.batchSize ?? resolvePruneBatchSize(),
        pauseMs: opts.pauseMs ?? resolvePrunePauseMs(),
        sleep: opts.sleep,
        ...(archiveEnabled ? { archiveTable } : {}),
      });
      rules.push({
        name: rule.name,
        days: rule.days,
        count: res.deleted,
        batches: res.batches,
        ...(res.archived !== undefined ? { archived: res.archived } : {}),
      });
    }
    return {
      service: this.serviceName,
      dryRun: opts.dryRun,
      rules,
      warnings: policy.warnings,
      archive,
    };
  }

  /**
   * Takroriy hodisani YANGI qator o'rniga mavjudiga qo'shadi (karta 4-band,
   * login hajmi): `windowMs` ichida AYNI (entity_type, entity_id, action,
   * user_id) va AYNI sessiya belgisi (ip + device_id + user_agent) qatori
   * bo'lsa — uning `metadata.count` i oshadi, `metadata.last_at`
   * yangilanadi; bo'lmasa oddiy `log()` (`metadata.count = 1`).
   *
   * Bitta atomik so'rov (CTE + `FOR UPDATE SKIP LOCKED`). Xato bo'lsa —
   * oddiy `log()` ga qaytiladi (jurnal yozuvi yo'qolmaydi).
   */
  async logCoalesced(input: ActivityLogInput, windowMs: number): Promise<void> {
    const ctx = requestContext.get();
    const audit = pickAuditContext(ctx);
    const given = asObject(input.metadata);
    const ip = textOrNull(given.ip) ?? audit.ip ?? null;
    const deviceId = textOrNull(given.device_id) ?? audit.device_id ?? null;
    const userAgent = textOrNull(given.user_agent) ?? audit.user_agent ?? null;
    const userId =
      input.user_id === null || input.user_id === undefined
        ? (pickAuditActor(ctx).userId ?? null)
        : String(input.user_id);

    if (Number.isFinite(windowMs) && windowMs > 0) {
      try {
        const { schema, tableName } = this.repo.metadata;
        const table = quoteActivityLogTable(schema, tableName);
        const rows: Array<{ bumped?: number | string }> | undefined =
          await this.repo.query(
            `WITH hit AS (
  SELECT s.id FROM ${table} AS s
   WHERE s.entity_type = $1 AND s.entity_id = $2 AND s.action = $3
     AND s.user_id IS NOT DISTINCT FROM $4
     AND s.created_at >= now() - make_interval(secs => $5)
     AND (s.metadata->>'ip') IS NOT DISTINCT FROM $6
     AND (s.metadata->>'device_id') IS NOT DISTINCT FROM $7
     AND (s.metadata->>'user_agent') IS NOT DISTINCT FROM $8
   ORDER BY s.created_at DESC, s.id DESC
   LIMIT 1
   FOR UPDATE SKIP LOCKED
), bumped AS (
  UPDATE ${table} AS t
     SET metadata = COALESCE(t.metadata, '{}'::jsonb)
       || jsonb_build_object(
            'count', COALESCE((t.metadata->>'count')::int, 1) + 1,
            'last_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM hit WHERE t.id = hit.id
  RETURNING t.id
)
SELECT COUNT(*)::int AS bumped FROM bumped`,
            [
              input.entity_type,
              String(input.entity_id),
              input.action,
              userId,
              windowMs / 1000,
              ip,
              deviceId,
              userAgent,
            ],
          );
        if (Number(rows?.[0]?.bumped ?? 0) > 0) return;
      } catch (err) {
        this.logger.warn(
          `activity-log coalesce failed (${input.action}), oddiy yozuvga qaytildi: ${(err as Error).message}`,
        );
      }
    }
    await this.activityLog.log({ ...input, metadata: { ...given, count: 1 } });
  }
}
