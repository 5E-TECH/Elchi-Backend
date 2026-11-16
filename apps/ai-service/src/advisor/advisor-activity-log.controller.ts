import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  ActivityLogService,
  RmqService,
  executeAndAck,
  type ActivityLogQuery,
} from '@app/common';

/**
 * BE-5 (§11) — ai-service faoliyat jurnali oyog'i: gateway `/activity-logs`
 * fan-in'i (`audit-gateway.controller.ts`) `{svc}.activity_log.find_all` /
 * `.find_by_entity` ni chaqiradi. Faqat O'QISH; ruxsat — gateway'da
 * (`@Roles(SUPERADMIN, ADMIN)`), boshqa servislar oyog'i bilan bir xil.
 * `ai.cap.raise` va `ai.advisor.*` yozuvlari endi jurnalda ko'rinadi.
 */
@Controller()
export class AdvisorActivityLogController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @MessagePattern({ cmd: 'ai.activity_log.find_all' })
  findAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.activityLog.query(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'ai.activity_log.find_by_entity' })
  findByEntity(
    @Payload() data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.activityLog.findByEntity(
        data?.entity_type,
        data?.entity_id,
        data?.limit ?? 50,
      ),
    );
  }
}
