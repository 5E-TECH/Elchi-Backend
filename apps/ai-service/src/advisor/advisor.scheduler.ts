import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { DataSource } from 'typeorm';
import { AdvisorNotifier } from './advisor-notify';
import { AdvisorRealtime } from './advisor-realtime';
import { AdvisorExplainService } from './advisor-explain.service';
import {
  AdvisorEngineService,
  type AdvisorRunGroup,
  type AdvisorRunResult,
} from './advisor-engine.service';

/** Har 30 daqiqada (sekund maydoni bilan), Asia/Tashkent — §4.0. */
export const ADVISOR_FREQUENT_CRON = '0 */30 * * * *';
/** Har kuni 02:30 Toshkent (digest'dan keyin) — R6, dushanba R8. */
export const ADVISOR_DAILY_CRON = '0 30 2 * * *';
/** Replikalararo qulf kalitlari (ikki guruh bir-birini to'smaydi). */
export const ADVISOR_LOCK_KEYS: Record<AdvisorRunGroup, number> = {
  frequent: 716_000_000_224,
  daily: 716_000_000_225,
};

/**
 * BE-5 (LhTIno57) — qoidalar rejalashtiruvchisi. 2 replikada bitta ishlaydi:
 * `pg_try_advisory_lock` (sessiya qulfi, alohida ulanishda; ish tugagach
 * ochiladi). Cron faqat `AI_ADVISOR_RULES=on` da (sukut — o'chiq).
 */
@Injectable()
export class AdvisorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdvisorScheduler.name);
  private readonly jobs: CronJob[] = [];
  private readonly running = new Set<AdvisorRunGroup>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly engine: AdvisorEngineService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly registry?: SchedulerRegistry,
    @Optional() private readonly notifier?: AdvisorNotifier,
    @Optional() private readonly realtime?: AdvisorRealtime,
    @Optional() private readonly explain?: AdvisorExplainService,
  ) {}

  enabled(): boolean {
    const flag = String(this.config?.get<string>('AI_ADVISOR_RULES') ?? '')
      .trim()
      .toLowerCase();
    // Sukut — O'CHIQ: faqat aniq 'on'/'true'/'1' yoqadi (round-2 ops-S3,
    // kelishilgan): deploy bilan backfill o'z-o'zidan boshlanmaydi.
    return flag === 'on' || flag === 'true' || flag === '1';
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.warn(
        'AI_ADVISOR_RULES on emas — maslahatchi qoidalari tekshirilmaydi',
      );
      return;
    }
    for (const [name, cronTime, group] of [
      ['ai-advisor-rules-frequent', ADVISOR_FREQUENT_CRON, 'frequent'],
      ['ai-advisor-rules-daily', ADVISOR_DAILY_CRON, 'daily'],
    ] as const) {
      const job = CronJob.from({
        cronTime,
        onTick: () => void this.tick(group),
        start: false,
        timeZone: 'Asia/Tashkent',
      });
      try {
        this.registry?.addCronJob(name, job);
      } catch {
        // allaqachon ro'yxatda (hot reload)
      }
      job.start();
      this.jobs.push(job);
    }
  }

  onModuleDestroy(): void {
    for (const job of this.jobs) {
      try {
        void job.stop();
      } catch {
        // allaqachon to'xtagan
      }
    }
  }

  /**
   * Tick'dan keyin (qulf ichida): realtime signal va jiddiylar
   * bildirishnomasi (§9.2 — `notified_at IS NULL` lar, qayta urinish ham).
   * Xatolar tick natijasini buzmaydi.
   */
  private async notifyPending(): Promise<void> {
    if (!this.notifier) return;
    try {
      const n = await this.notifier.dispatchPending();
      if (n.sent || n.failed)
        this.logger.log(`ai_advisor_notify sent=${n.sent} failed=${n.failed}`);
    } catch (error) {
      this.logger.warn(
        `ai_advisor_notify_failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
      );
    }
  }

  private async afterRun(result: AdvisorRunResult): Promise<void> {
    if (this.realtime && result.changes.length) {
      try {
        const rows = await this.ds.query<
          Array<{
            id: string;
            rule_key: string;
            severity: string;
            status: string;
            explanation_status: string;
          }>
        >(
          `SELECT "id"::text AS id, "rule_key", "severity", "status", "explanation_status"
             FROM ai_schema.ai_advisor_alerts WHERE "id" = ANY($1::bigint[])`,
          [result.changes.map((c) => c.alert_id)],
        );
        const at = new Date().toISOString();
        const byId = new Map(rows.map((r) => [r.id, r]));
        this.realtime.emit(
          result.changes.flatMap((c) => {
            const r = byId.get(c.alert_id);
            return r
              ? [
                  {
                    alert_id: r.id,
                    rule_key: r.rule_key,
                    severity: r.severity,
                    status: r.status,
                    change: c.change,
                    explanation_status: r.explanation_status,
                    at,
                  },
                ]
              : [];
          }),
        );
      } catch (error) {
        this.logger.warn(
          `ai_advisor_realtime_failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
        );
      }
    }
    await this.notifyPending();
    if (this.explain) {
      // §6: jiddiylarga darhol izoh (≤ 5/tick), eskirgan `pending` → failed.
      try {
        const opened = result.changes
          .filter((c) => c.change === 'opened')
          .map((c) => c.alert_id);
        const e = await this.explain.autoExplain(new Date(), opened);
        if (e.queued || e.stale)
          this.logger.log(
            `ai_advisor_explain queued=${e.queued} stale=${e.stale}`,
          );
      } catch (error) {
        this.logger.warn(
          `ai_advisor_explain_auto_failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
        );
      }
    }
  }

  /**
   * ⚠️ Qulf — sessiya `pg_try_advisory_lock` alohida ulanishda; u uzilsa
   * (tarmoq, pooler failover) qulf bo'shaydi va boshqa replika ayni guruhni
   * parallel boshlashi mumkin. Dvigatel idempotent (ochiq qator FOR UPDATE,
   * `(dedup_key, fact_key)` UNIQUE), bildirishnoma — deterministik
   * `client_request_id` bilan dedup; shuning uchun ikki marta ishlash
   * natijani buzmaydi (round-2 ops-S6).
   */
  /** Bitta tick; qulf boshqa replikada bo'lsa — `null`. Xato yutiladi (log). */
  async tick(
    group: AdvisorRunGroup,
    now: Date = new Date(),
  ): Promise<AdvisorRunResult | null> {
    if (this.running.has(group)) return null;
    this.running.add(group);
    const runner = this.ds.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS ok',
        [ADVISOR_LOCK_KEYS[group]],
      )) as Array<{ ok: boolean }>;
      const row = rows[0];
      locked = row?.ok === true;
      if (!locked) return null;
      const result = await this.engine.run(group, now);
      this.logger.log(
        `ai_advisor_rules group=${group} rules=${result.rules.join(',')} candidates=${result.candidates} ` +
          `opened=${result.opened} occurred=${result.occurred} refreshed=${result.refreshed} failed=${result.failed}`,
      );
      await this.afterRun(result);
      return result;
    } catch (error) {
      this.logger.error(
        `ai_advisor_rules_failed group=${group}: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}`,
      );
      // Qoidalar yiqilsa ham kutayotgan bildirishnomalar qayta urinadi
      // (finance o'chiq bo'lsa ham; round-2 S4).
      if (locked) {
        await this.notifyPending();
        // Eskirgan `pending` tozalash qoidalar yiqilsa ham (round-3 nit).
        await this.explain?.autoExplain(new Date(), []).catch(() => undefined);
      }
      return null;
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock($1::bigint)', [
            ADVISOR_LOCK_KEYS[group],
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
      this.running.delete(group);
    }
  }
}
