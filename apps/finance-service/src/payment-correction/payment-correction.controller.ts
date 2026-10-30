import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  PaymentCorrectionService,
  type PaymentCorrectionInput,
} from './payment-correction.service';

/**
 * T6 — to'lovni qaytarish / summasini tuzatish (gateway:
 * `/finance/history/:id/reverse`, `/finance/history/:id/correct-amount`,
 * `/finance/payment-corrections/settings`). Idempotentlik — servisda
 * (`Idempotency-Key` UNIQUE): RMQ qayta yetkazishi ham o'sha kalit bilan
 * keladi va pulni ikkinchi marta ko'chirmaydi.
 */
@Controller()
export class PaymentCorrectionController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly corrections: PaymentCorrectionService,
  ) {}

  @MessagePattern({ cmd: 'finance.payment_correction.settings.get' })
  getSettings(@Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.corrections.getSettings(),
    );
  }

  @MessagePattern({ cmd: 'finance.payment_correction.settings.update' })
  updateSettings(
    @Payload()
    data: Parameters<PaymentCorrectionService['updateSettings']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.corrections.updateSettings(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.payment_correction.context' })
  context(
    @Payload() data: { history_id?: string; idempotency_key?: string },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.corrections.context(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.payment_correction.reverse' })
  reverse(@Payload() data: PaymentCorrectionInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.corrections.reverse(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.payment_correction.correct_amount' })
  correctAmount(
    @Payload() data: PaymentCorrectionInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.corrections.correctAmount(data ?? {}),
    );
  }
}
