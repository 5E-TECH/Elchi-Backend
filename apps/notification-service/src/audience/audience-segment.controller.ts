import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { AudienceSegmentService } from './audience-segment.service';
import type { CreateAudienceSegmentInput } from './audience-segment.service';

/**
 * (ebSV5oyP #7) Saqlangan auditoriya segmentlari — RMQ. Gateway:
 * `GET/POST /notifications/audience/segments`,
 * `DELETE /notifications/audience/segments/:id` (SUPERADMIN/ADMIN).
 */
@Controller()
export class AudienceSegmentController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly segments: AudienceSegmentService,
  ) {}

  @MessagePattern({ cmd: 'notification.audience.segments.list' })
  list(@Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () => this.segments.list());
  }

  @MessagePattern({ cmd: 'notification.audience.segments.create' })
  create(
    @Payload() data: CreateAudienceSegmentInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.segments.create(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'notification.audience.segments.delete' })
  remove(@Payload() data: { id?: string }, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.segments.remove(data ?? {}),
    );
  }
}
