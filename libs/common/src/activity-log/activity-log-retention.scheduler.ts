import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { captureException } from '../sentry/sentry.helper';
import {
  ActivityLogMaintenanceService,
  ActivityLogPruneReport,
} from './activity-log-maintenance.service';
import {
  ACTIVITY_LOG_PRUNE_TIMEZONE,
  activityLogPruneCronFor,
  isActivityLogPruneEnabled,
} from './retention-policy';
import { ACTIVITY_LOG_SERVICE_NAME } from './types';

/** `true` — cron umuman ro'yxatdan o'tmaydi (masalan, bir martalik skriptlar). */
export const ACTIVITY_LOG_PRUNE_CRON_DISABLED_ENV =
  'ACTIVITY_LOG_PRUNE_CRON_DISABLED';

/**
 * i6Nyedea — HAR servisda (`ActivityLogModule.forService`) o'z
 * `activity_logs` jadvali uchun kunlik retention cron'i.
 *
 * - Vaqt servis bo'yicha TAQSIMLANGAN (`ACTIVITY_LOG_PRUNE_SCHEDULE`,
 *   Toshkent, 03:05–04:35) — hammasi bir daqiqada bitta Postgres'ni
 *   yuklamaydi.
 * - ⚠️ `ACTIVITY_LOG_PRUNE_ENABLED=true` bo'lmaguncha DRY-RUN: hech narsa
 *   o'chirilmaydi, faqat sanaladi va TIZIM log'iga yoziladi.
 * - Natija `activity_logs` ga YOZILMAYDI (jadval o'zini to'ldirmasin).
 * - i6Nyedea arxiv: yoqilganda qatorlar `activity_logs_archive` ga
 *   KO'CHIRILADI; dry-run'da arxiv jadvali yo'q bo'lsa — ogohlantirish
 *   (bayroq yoqilsa o'chirish shu sababli rad etiladi).
 * - Xato — `logger.error` + Sentry (`captureException`), jim yutilmaydi;
 *   servisni yiqitmaydi.
 * - `@nestjs/schedule` modulisiz (servis modullariga tegilmaydi) —
 *   integration-service'dagi kabi to'g'ridan-to'g'ri `CronJob`.
 */
@Injectable()
export class ActivityLogRetentionScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ActivityLogRetentionScheduler.name);
  private job: CronJob | null = null;
  private running = false;

  constructor(
    private readonly maintenance: ActivityLogMaintenanceService,
    @Optional()
    @Inject(ACTIVITY_LOG_SERVICE_NAME)
    private readonly serviceName: string | null = null,
  ) {}

  /** Shu servisning cron ifodasi (env bilan almashtirilishi mumkin). */
  get cronTime(): string {
    return activityLogPruneCronFor(this.serviceName);
  }

  onApplicationBootstrap(): void {
    const disabled = String(
      process.env[ACTIVITY_LOG_PRUNE_CRON_DISABLED_ENV] ?? '',
    )
      .trim()
      .toLowerCase();
    if (disabled === 'true' || disabled === '1') {
      this.logger.log('activity_logs retention cron o`chiq (env)');
      return;
    }
    try {
      this.job = CronJob.from({
        cronTime: this.cronTime,
        onTick: () => {
          void this.run();
        },
        start: true,
        timeZone: ACTIVITY_LOG_PRUNE_TIMEZONE,
        unrefTimeout: true,
      });
      this.logger.log(
        `activity_logs retention cron: ${this.cronTime} (${ACTIVITY_LOG_PRUNE_TIMEZONE}), ` +
          `rejim: ${isActivityLogPruneEnabled() ? "O'CHIRISH" : 'dry-run'}`,
      );
    } catch (err) {
      // Noto'g'ri cron ifodasi (env) servisni yiqitmasin.
      this.logger.error(
        `activity_logs retention cron ro'yxatdan o'tmadi: ${(err as Error).message}`,
      );
      captureException(err, {
        source: 'ActivityLogRetentionScheduler.bootstrap',
        service: this.serviceName,
      });
    }
  }

  onModuleDestroy(): void {
    void this.job?.stop();
    this.job = null;
  }

  /**
   * Bitta ishga tushish. Parallel ikkinchi tick (oldingisi hali ishlayapti)
   * — o'tkazib yuboriladi. Natija — tizim log'iga (`activity_logs` ga emas).
   */
  async run(): Promise<ActivityLogPruneReport | null> {
    if (this.running) {
      this.logger.warn(
        'activity_logs retention: oldingi ishga tushish hali tugamagan',
      );
      return null;
    }
    this.running = true;
    const dryRun = !isActivityLogPruneEnabled();
    const startedAt = Date.now();
    try {
      const report = await this.maintenance.pruneByPolicy({ dryRun });
      for (const warning of report.warnings) this.logger.warn(warning);
      const archive = report.archive;
      if (archive?.enabled && archive.ready === false) {
        this.logger.warn(
          `activity_logs retention [${this.serviceName ?? '-'}]: arxiv jadvali yo'q (${archive.table}) — ` +
            `ACTIVITY_LOG_PRUNE_ENABLED yoqilsa o'chirish RAD etiladi (migratsiya 1716000000101)`,
        );
      }
      const summary = report.rules
        .map((r) => `${r.name}(${r.days} kun)=${r.count}`)
        .join(', ');
      const verb = dryRun
        ? archive?.enabled
          ? "dry-run — arxivga ko'chiriladigan"
          : "dry-run — o'chiriladigan"
        : archive?.enabled
          ? "arxivga ko'chirildi"
          : "o'chirildi (ARXIVSIZ)";
      this.logger.log(
        `activity_logs retention [${this.serviceName ?? '-'}] ` +
          `${verb}: ${summary}; ` +
          `${Date.now() - startedAt} ms`,
      );
      return report;
    } catch (err) {
      this.logger.error(
        `activity_logs retention [${this.serviceName ?? '-'}] XATO: ${(err as Error).message}`,
        (err as Error).stack,
      );
      captureException(err, {
        source: 'ActivityLogRetentionScheduler.run',
        service: this.serviceName,
        dryRun,
      });
      return null;
    } finally {
      this.running = false;
    }
  }
}
