import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService, Group_type } from '@app/common';
import { NotificationServiceService } from './notification-service.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';

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
      const result = await handler();
      this.rmqService.ack(context);
      return result;
    } catch (error) {
      this.rmqService.nack(context);
      throw error;
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
  createTelegramMarket(
    @Payload() data: CreateNotificationDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.createTelegramMarket(data),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.find_all' })
  findAllTelegramMarkets(
    @Payload()
    data: {
      market_id?: string;
      group_type?: Group_type;
      is_active?: boolean;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.findAllTelegramMarkets(data),
    );
  }

  // Backward compatibility for existing callers
  @MessagePattern({ cmd: 'notification.telegram.find_by_market' })
  findByMarket(
    @Payload()
    data: {
      market_id?: string;
      group_type?: Group_type;
      is_active?: boolean;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.findAllTelegramMarkets(data),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.find_one' })
  findOneTelegramMarket(
    @Payload() data: { id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.findTelegramMarketById(data.id),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.update' })
  updateTelegramMarket(
    @Payload() data: UpdateNotificationDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.updateTelegramMarket(data),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.connect_by_token' })
  connectByToken(
    @Payload() data: { text: string; group_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.connectGroupByTokenText(data.text, data.group_id),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.delete' })
  deleteTelegramMarket(
    @Payload() data: { id?: string; market_id?: string; group_type?: Group_type },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.deleteTelegramMarket(data),
    );
  }

  @MessagePattern({ cmd: 'notification.send' })
  sendNotification(
    @Payload() data: SendNotificationDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.sendNotification(data),
    );
  }
}
