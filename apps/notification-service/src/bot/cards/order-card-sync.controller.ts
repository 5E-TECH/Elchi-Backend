import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  OrderCardSyncService,
  TELEGRAM_ORDER_STATUS_PATTERN,
} from './order-card-sync.service';
import type { OrderStatusEvent } from './order-card-sync.service';

/**
 * (h9newLsd #5 / ysBqD9Nx #4) order-service outbox'i (fire-and-forget) →
 * Telegram kartalarini tahrirlash. Bot o'zi so'rov (polling) qilmaydi.
 */
@Controller()
export class OrderCardSyncController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly cards: OrderCardSyncService,
  ) {}

  @MessagePattern({ cmd: TELEGRAM_ORDER_STATUS_PATTERN })
  sync(@Payload() data: OrderStatusEvent, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.sync(data ?? {}),
    );
  }
}
