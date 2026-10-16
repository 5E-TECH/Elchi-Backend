import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { AudiencePreviewService } from '../audience/audience-preview.service';
import type { AudiencePreviewInput } from '../audience/audience-preview.service';
import { CampaignService } from './campaign.service';
import type {
  CampaignBatchPayload,
  CreateCampaignInput,
} from './campaign.service';
import { CAMPAIGN_BATCH_PATTERN } from './campaign-limits';

/**
 * (W8aerwL6 / xHPdpj0W) Auditoriya ko'rinishi va kampaniya navbati RMQ
 * patternlari — mavjud NotificationServiceController'dan alohida (uning
 * konstruktoriga tegilmaydi).
 */
@Controller()
export class CampaignController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly preview: AudiencePreviewService,
    private readonly campaigns: CampaignService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  /** (W8aerwL6 #5) Yuborishdan oldin: son, rollar kesimi, kanal bo'yicha. */
  @MessagePattern({ cmd: 'notification.audience.preview' })
  audiencePreview(
    @Payload() data: AudiencePreviewInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.preview.preview(data ?? {}));
  }

  /** (xHPdpj0W) Darhol 202 `{ campaign_id }` — yuborish fonda. */
  @MessagePattern({ cmd: 'notification.campaign.create' })
  createCampaign(
    @Payload() data: CreateCampaignInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.campaigns.create(data ?? {}));
  }

  @MessagePattern({ cmd: 'notification.campaign.list' })
  listCampaigns(
    @Payload()
    data: { page?: number; limit?: number; status?: string; state?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.campaigns.list(data ?? {}));
  }

  /** (WIsb9Ytq) Toshkent zonasi, reklama taqiq oynasi, vaqt tekshiruvi. */
  @MessagePattern({ cmd: 'notification.campaign.schedule_policy' })
  schedulePolicy(
    @Payload()
    data: { scheduled_at?: string; type?: string; category?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.campaigns.schedulePolicy(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'notification.campaign.get' })
  getCampaign(@Payload() data: { id?: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.campaigns.get(data ?? {}));
  }

  @MessagePattern({ cmd: 'notification.campaign.cancel' })
  cancelCampaign(
    @Payload()
    data: {
      id?: string;
      requester?: { id?: string | number | null; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.campaigns.cancel(data ?? {}));
  }

  /** Outbox iste'molchisi — bitta partiya (ichki; gateway'da yo'q). */
  @MessagePattern({ cmd: CAMPAIGN_BATCH_PATTERN })
  campaignBatch(
    @Payload() data: CampaignBatchPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.campaigns.runBatch(data ?? {}),
    );
  }
}
