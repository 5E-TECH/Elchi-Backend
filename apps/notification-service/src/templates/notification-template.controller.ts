import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { NotificationTemplateService } from './notification-template.service';
import type { UpsertNotificationTemplateInput } from './notification-template.service';

/**
 * (C4R3YyvH #6) Shablonlar reyestri RMQ patternlari — mavjud
 * NotificationServiceController'dan alohida. Gateway:
 * `GET/PUT /notifications/templates` (SUPERADMIN/ADMIN).
 */
@Controller()
export class NotificationTemplateController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly templates: NotificationTemplateService,
  ) {}

  @MessagePattern({ cmd: 'notification.templates.list' })
  list(
    @Payload() data: { code?: string; lang?: string },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.templates.list(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'notification.templates.upsert' })
  upsert(
    @Payload() data: UpsertNotificationTemplateInput,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.templates.upsert(data ?? {}),
    );
  }
}
