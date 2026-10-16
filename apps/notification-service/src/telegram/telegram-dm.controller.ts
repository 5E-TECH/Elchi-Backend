import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  TELEGRAM_DM_DELIVER_PATTERN,
  TelegramDmService,
} from './telegram-dm.service';

/**
 * (rCFZAmOz) Shaxsiy Telegram: ulash havolasi va outbox yetkazuvchisi —
 * mavjud NotificationServiceController'dan alohida.
 */
@Controller()
export class TelegramDmController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly dm: TelegramDmService,
  ) {}

  /** Gateway `POST /notifications/telegram/link` (user_id, roles — JWT'dan). */
  @MessagePattern({ cmd: 'notification.telegram.link_token' })
  linkToken(
    @Payload() data: { user_id?: string; roles?: string[]; ip?: string },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.dm.linkToken(data ?? {}),
    );
  }

  /**
   * (6jXw0DDr / 4TfLyTrL / 9uNhwTZp) Gateway `POST /telegram/link-code` va
   * `POST /users/me/telegram/link-code` — bir martalik kod (requester JWT'dan).
   */
  @MessagePattern({ cmd: 'notification.telegram.link_code' })
  linkCode(
    @Payload()
    data: {
      purpose?: string;
      requester?: { id?: string; roles?: string[] };
      market_id?: string;
      group_type?: string;
      ip?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.dm.issueLinkCode(data ?? {}),
    );
  }

  /** Outbox → shaxsiy xabarlar (idempotent da'vo bilan). */
  @MessagePattern({ cmd: TELEGRAM_DM_DELIVER_PATTERN })
  deliver(
    @Payload() data: { notification_ids?: string[] },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.dm.deliver(data ?? {}),
    );
  }
}
