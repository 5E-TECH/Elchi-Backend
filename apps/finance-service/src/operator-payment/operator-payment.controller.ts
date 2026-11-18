import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  OperatorPaymentService,
  type OperatorBalancesInput,
  type OperatorPaymentCancelInput,
  type OperatorPaymentListInput,
  type OperatorPaymentRecordInput,
} from './operator-payment.service';

/**
 * F2qp6FtE — market o'z operatoriga to'lov yozuvi (gateway:
 * `/finance/operator-payments`). Kassaga TEGMAYDI. Idempotentlik servisda:
 * `record` — `(market_id, idempotency_key)` UNIQUE, `cancel` — takror 200.
 */
@Controller()
export class OperatorPaymentController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly payments: OperatorPaymentService,
  ) {}

  @MessagePattern({ cmd: 'finance.operator.market_payment.record' })
  record(
    @Payload() data: OperatorPaymentRecordInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.payments.record(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.market_payment.cancel' })
  cancel(
    @Payload() data: OperatorPaymentCancelInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.payments.cancel(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.market_payment.list' })
  list(@Payload() data: OperatorPaymentListInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.payments.list(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.market_balances' })
  balances(@Payload() data: OperatorBalancesInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.payments.balances(data ?? {}),
    );
  }
}
