import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { captureException } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * `awaiting_config` hamkor webhooklari uchun KUNLIK yig'ma ogohlantirish
 * (vy9gakYq).
 *
 * MUAMMO. Hamkorda `webhook_url` yo'q bo'lsa hodisa `awaiting_config` da
 * kutadi — bu to'g'ri, lekin bu haqda faqat `logger.warn` yozilardi: prodda
 * id 7, 8 qatorlar 8 kun davomida hech kim bilmasdan yotdi. Endi kuniga bir
 * marta admin guruhiga "N ta hodisa X hamkorda kutmoqda" xabari ketadi.
 * Ikki replika — `digestAwaitingConfigPartnerWebhooks` ichidagi advisory
 * qulf bittasini o'tkazadi.
 */
@Injectable()
export class PartnerWebhookDigestScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PartnerWebhookDigestScheduler.name);
  private static readonly JOB_NAME = 'integration.partner_webhook.digest';

  private running = false;
  private job?: CronJob;

  constructor(
    @Inject(IntegrationServiceService)
    private readonly integrationService: IntegrationServiceService,
    @Inject(SchedulerRegistry)
    private readonly scheduler: SchedulerRegistry,
    @Inject(ConfigService)
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>(
      'INTEGRATION_WEBHOOK_DIGEST_CRON_ENABLED',
      true,
    );
    if (!enabled) {
      this.logger.warn(
        'INTEGRATION_WEBHOOK_DIGEST_CRON_ENABLED=false — awaiting_config kunlik ogohlantirishi o`chiq.',
      );
      return;
    }
    const expression = this.config.get<string>(
      'INTEGRATION_WEBHOOK_DIGEST_CRON_EXPR',
      '0 0 4 * * *',
    );
    this.job = new CronJob(expression, () => {
      void this.tick();
    });
    this.scheduler.addCronJob(
      PartnerWebhookDigestScheduler.JOB_NAME,
      this.job as never,
    );
    this.job.start();
    this.logger.log(`partner webhook digest started: cron='${expression}'`);
  }

  onModuleDestroy(): void {
    if (this.job) {
      try {
        void this.job.stop();
      } catch {
        // Already stopped — ignore.
      }
    }
  }

  /** Bitta ishga tushish. Xatolar yutiladi (log + Sentry) — cron o'lmasin. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const res =
        await this.integrationService.digestAwaitingConfigPartnerWebhooks();
      if (res.total > 0) {
        this.logger.log(
          `awaiting_config digest: total=${res.total} partners=${res.partners.length} notified=${res.notified}`,
        );
      }
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `partner webhook digest crashed: ${error.message}`,
        error.stack,
      );
      captureException(error, { source: 'PartnerWebhookDigestScheduler.tick' });
    } finally {
      this.running = false;
    }
  }
}
