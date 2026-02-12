import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { NotificationServiceService } from './notification-service.service';

@Controller()
export class NotificationServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly notificationService: NotificationServiceService,
  ) {}

  private async executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await handler();
    } finally {
      this.rmqService.ack(context);
    }
  }

  @MessagePattern({ cmd: 'notification.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'notification-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'notification.telegram.create' })
  createTelegramMarket(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'notification.telegram.find_by_market' })
  findByMarket(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'notification.telegram.update' })
  updateTelegramMarket(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'notification.telegram.delete' })
  deleteTelegramMarket(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'notification.send' })
  sendNotification(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
