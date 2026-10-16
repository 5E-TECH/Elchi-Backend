import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  CAMPAIGN_EXPORT_RUN_PATTERN,
  CampaignReportService,
} from './campaign-report.service';
import type { CampaignReportInput } from './campaign-report.service';

type Requester = { id?: string | number | null; roles?: string[] } | null;

/**
 * (H7kpCman) Kampaniya natijasi hisoboti RMQ patternlari — bildirishnoma
 * (`kind: notification`) va SMS (`kind: sms`) kampaniyalari uchun bitta
 * kontrakt. Mavjud CampaignController'ga tegilmaydi.
 */
@Controller()
export class CampaignReportController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly reports: CampaignReportService,
  ) {}

  private run<T>(context: RmqContext, handler: () => Promise<T> | T) {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: 'notification.campaign.report' })
  report(@Payload() data: CampaignReportInput, @Ctx() context: RmqContext) {
    return this.run(context, () => this.reports.report(data ?? {}));
  }

  @MessagePattern({ cmd: 'notification.campaign.undelivered' })
  undelivered(
    @Payload() data: CampaignReportInput & { page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.reports.undelivered(data ?? {}));
  }

  /** CSV — faqat superadmin; >10 000 qator — fon vazifasi (202). */
  @MessagePattern({ cmd: 'notification.campaign.export' })
  exportUndelivered(
    @Payload() data: CampaignReportInput,
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.reports.exportUndelivered(data ?? {}));
  }

  @MessagePattern({ cmd: 'notification.campaign.export.get' })
  getExport(
    @Payload() data: { export_id?: string; requester?: Requester },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.reports.getExport(data ?? {}));
  }

  @MessagePattern({ cmd: 'notification.campaign.export.download' })
  downloadExport(
    @Payload() data: { export_id?: string; requester?: Requester },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.reports.downloadExport(data ?? {}));
  }

  /** Outbox iste'molchisi (ichki; gateway'da yo'q). */
  @MessagePattern({ cmd: CAMPAIGN_EXPORT_RUN_PATTERN })
  runExport(
    @Payload() data: { export_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.reports.runExport(data ?? {}));
  }
}
