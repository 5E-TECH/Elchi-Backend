import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { CustomerSegmentService } from './customer-segment.service';
import type {
  CustomerMarketSummaryInput,
  CustomerSegmentFilter,
} from './customer-segment.service';

/** notification-service kampaniyasi uchun mijoz segmenti (sVByLMnt #5). */
@Controller()
export class CustomerSegmentController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly segments: CustomerSegmentService,
  ) {}

  @MessagePattern({ cmd: 'order.customer.segment' })
  segment(@Payload() data: CustomerSegmentFilter, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.segments.find(data ?? {}),
    );
  }

  /** hiqRNhkI: telefon taklifi uchun mijozlarning shu marketdagi xulosasi. */
  @MessagePattern({ cmd: 'order.customer.market_summary' })
  marketSummary(
    @Payload() data: CustomerMarketSummaryInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.segments.marketSummary(data ?? {}),
    );
  }
}
