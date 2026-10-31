import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  PickupVisitService,
  type PickupVisitListInput,
  type PickupVisitRecordInput,
} from './pickup-visit.service';

/**
 * B824gOu5 — pickup tashrifi (gateway: `/finance/pickup-visits`). Idempotentlik
 * servisda (`idempotency_key` UNIQUE): RMQ qayta yetkazishi ham o'sha kalit
 * bilan keladi va haqni ikkinchi marta yozmaydi.
 */
@Controller()
export class PickupVisitController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly visits: PickupVisitService,
  ) {}

  @MessagePattern({ cmd: 'finance.pickup_visit.record' })
  record(@Payload() data: PickupVisitRecordInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.visits.record(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.pickup_visit.find_all' })
  findAll(@Payload() data: PickupVisitListInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.visits.findAll(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.pickup_visit.income_summary' })
  incomeSummary(
    @Payload() data: { from_date?: string; to_date?: string },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.visits.incomeSummary(data ?? {}),
    );
  }
}
