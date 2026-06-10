import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService, Group_type, executeAndAck } from '@app/common';
import { NotificationServiceService } from './notification-service.service';
import { NotificationInboxService } from './notification-inbox.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';

@Controller()
export class NotificationServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly notificationService: NotificationServiceService,
    private readonly inboxService: NotificationInboxService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
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

  // ==================== In-app notification inbox ====================

  /** Generic entry point any service calls to raise a notification. */
  @MessagePattern({ cmd: 'notification.dispatch' })
  dispatch(
    @Payload() data: DispatchNotificationDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.dispatch(data),
    );
  }

  @MessagePattern({ cmd: 'notification.inbox.list' })
  listInbox(
    @Payload() data: ListNotificationsDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.inboxService.list(data));
  }

  @MessagePattern({ cmd: 'notification.inbox.find_one' })
  findOneInbox(
    @Payload() data: { recipient_id: string; id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.findOne(data.recipient_id, data.id),
    );
  }

  @MessagePattern({ cmd: 'notification.inbox.unread_count' })
  unreadCount(
    @Payload() data: { recipient_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.unreadCount(data.recipient_id),
    );
  }

  @MessagePattern({ cmd: 'notification.inbox.mark_read' })
  markRead(
    @Payload() data: { recipient_id: string; id: string; read?: boolean },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.markRead(data.recipient_id, data.id, data.read ?? true),
    );
  }

  @MessagePattern({ cmd: 'notification.inbox.mark_all_read' })
  markAllRead(
    @Payload() data: { recipient_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.markAllRead(data.recipient_id),
    );
  }

  @MessagePattern({ cmd: 'notification.inbox.delete' })
  deleteInbox(
    @Payload() data: { recipient_id: string; id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.remove(data.recipient_id, data.id),
    );
  }
}
