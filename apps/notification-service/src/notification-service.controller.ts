import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  RmqService,
  Group_type,
  executeAndAck,
  ActivityLogQuery,
} from '@app/common';
import { NotificationServiceService } from './notification-service.service';
import { NotificationInboxService } from './notification-inbox.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { PushSubscriptionService } from './push/push-subscription.service';
import type {
  SubscribePushInput,
  UnsubscribePushInput,
} from './push/push-subscription.service';
import {
  PUSH_DELIVER_PATTERN,
  PushDeliveryService,
} from './push/push-delivery.service';
import type { PushDeliverInput } from './push/push-delivery.service';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';
import {
  ESCALATE_PATTERN,
  NotificationEscalationService,
} from './escalation/notification-escalation.service';
import type { EscalateInput } from './escalation/notification-escalation.service';
import { BotRuntimeService } from './bot/bot-runtime.service';

@Controller()
export class NotificationServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly notificationService: NotificationServiceService,
    private readonly inboxService: NotificationInboxService,
    private readonly pushSubscriptions: PushSubscriptionService,
    private readonly pushDelivery: PushDeliveryService,
    private readonly preferences: NotificationPreferencesService,
    private readonly escalation: NotificationEscalationService,
    private readonly botRuntime: BotRuntimeService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  /**
   * Readiness (gateway `/health/readiness`). (Mvx0h1Fv #5 / 9HIaV80X #6) Bot
   * tokeni sozlangan-u `getMe` dan o'tmagan bo'lsa — `degraded` (readiness
   * qizil): "healthcheck yashil, bot o'lik" holati takrorlanmasin. Token
   * umuman berilmagan (bot o'chiq) — ta'sir yo'q. Docker liveness'iga
   * (`GET /health`) bu tegmaydi.
   */
  @MessagePattern({ cmd: 'notification.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'notification-service',
      status: this.botRuntime.isDegraded() ? 'degraded' : 'ok',
      bot: this.botRuntime.health(),
      timestamp: new Date().toISOString(),
    }));
  }

  // (qXlFQp8Q) HTTP yo'li (POST /notifications) yopiq — 410 Gone; gateway bu
  // patternni endi chaqirmaydi. Faqat ichki ops (RMQ) uchun qoldirildi —
  // tashqaridan guruh ID'sini qo'lda yozib ulash imkoni yo'q.
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

  /** (KJNHAlGW) GET /notifications/me/telegram-groups — market o'z guruhlari. */
  @MessagePattern({ cmd: 'notification.telegram.my_groups' })
  findMyTelegramGroups(
    @Payload() data: { requester?: { id?: unknown; roles?: unknown } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.findMyTelegramGroups(data),
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
    // (3SeRYFqx #1) HTTP yo'li — xato RpcException (400/404), { message }
    // emas. Bot o'zi connectGroupByTokenText ni chaqiradi (guruhga javob).
    return this.executeAndAck(context, () =>
      this.notificationService.connectGroupByToken(data.text, data.group_id),
    );
  }

  @MessagePattern({ cmd: 'notification.telegram.delete' })
  deleteTelegramMarket(
    @Payload()
    data: { id?: string; market_id?: string; group_type?: Group_type },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.deleteTelegramMarket(data),
    );
  }

  /**
   * @deprecated (TgYRqaTk #2) ICHKI / ESKIRGAN — faqat superadminning qo'lda
   * guruh relay'i (`POST /notifications/send`). Servislar bu pattern'ni
   * CHAQIRMAYDI: hodisa → `notification.dispatch` (shablon, kanal tanlash,
   * `delivery` holati yadroda; TELEGRAM — uning bir kanali). Bot tokeni
   * payload'da qabul qilinmaydi (faqat env).
   */
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
    return this.executeAndAck(context, () => this.inboxService.dispatch(data));
  }

  /** Bildirishnoma turlari reyestri (Eh8y21Ha) — `GET /notifications/types`. */
  @MessagePattern({ cmd: 'notification.types.list' })
  listTypes(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.inboxService.listTypes());
  }

  @MessagePattern({ cmd: 'notification.inbox.list' })
  listInbox(@Payload() data: ListNotificationsDto, @Ctx() context: RmqContext) {
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

  @MessagePattern({ cmd: 'notification.inbox.counts' })
  inboxCounts(
    @Payload() data: { recipient_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.inboxService.counts(data.recipient_id),
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

  // ==================== Web Push ====================

  @MessagePattern({ cmd: 'notification.push.public_key' })
  pushPublicKey(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.pushSubscriptions.getPublicKey(),
    );
  }

  @MessagePattern({ cmd: 'notification.push.subscribe' })
  pushSubscribe(
    @Payload() data: SubscribePushInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.pushSubscriptions.subscribe(data),
    );
  }

  @MessagePattern({ cmd: 'notification.push.unsubscribe' })
  pushUnsubscribe(
    @Payload() data: UnsubscribePushInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.pushSubscriptions.unsubscribe(data),
    );
  }

  /** Outbox iste'molchisi — dispatch navbatga qo'ygan push'larni yetkazadi. */
  @MessagePattern({ cmd: PUSH_DELIVER_PATTERN })
  pushDeliver(@Payload() data: PushDeliverInput, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.pushDelivery.deliver(data));
  }

  // ==================== Sozlamalar (mP1WGG1W) ====================

  /** `GET /notifications/preferences` — `user_id` FAQAT JWT'dan (gateway). */
  @MessagePattern({ cmd: 'notification.preferences.get' })
  preferencesGet(
    @Payload() data: { user_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.preferences.get(data));
  }

  /** `PATCH /notifications/preferences` — `{ user_id (JWT), items: [...] }`. */
  @MessagePattern({ cmd: 'notification.preferences.update' })
  preferencesUpdate(
    @Payload() data: { user_id?: string; items?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.preferences.update(data));
  }

  /**
   * (7Ec56EIw #5) Outbox iste'molchisi — CRITICAL xabar N daqiqada
   * o'qilmagan bo'lsa SMS eskalatsiyasi (ATIGI BIR MARTA).
   */
  @MessagePattern({ cmd: ESCALATE_PATTERN })
  escalate(@Payload() data: EscalateInput, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.escalation.handle(data));
  }

  // ==================== Audit-log reads (gateway fan-in) ====================

  @MessagePattern({ cmd: 'notification.activity_log.find_all' })
  activityLogFindAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'notification.activity_log.find_by_entity' })
  activityLogFindByEntity(
    @Payload()
    data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.notificationService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
