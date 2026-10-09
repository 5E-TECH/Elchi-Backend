import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  SETTLEMENT_UNAPPLIED_RECORDED_PATTERN,
  SettlementUnappliedService,
} from './settlement-unapplied.service';
import type { SettlementUnappliedInput } from './settlement-unapplied.service';

/**
 * znD3KaZL — order-service outbox'idan keladigan FIFO qoldig'i hodisasi
 * (sekin, kafolatlangan yo'l). Ichki RMQ handler — gateway'da marshrut yo'q.
 */
@Controller()
export class SettlementUnappliedController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly unapplied: SettlementUnappliedService,
  ) {}

  @MessagePattern({ cmd: SETTLEMENT_UNAPPLIED_RECORDED_PATTERN })
  unappliedRecorded(
    @Payload() data: SettlementUnappliedInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.unapplied.handleRecordedEvent(data),
    );
  }
}
