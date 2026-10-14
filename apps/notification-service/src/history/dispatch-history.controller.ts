import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { DispatchHistoryService } from './dispatch-history.service';

/**
 * (7Vozou5x) Yuborilgan xabarlar tarixi RMQ patternlari — mavjud
 * NotificationServiceController'dan alohida (uning konstruktoriga tegilmaydi).
 * Gateway: `GET /notifications/sent`, `GET /notifications/sent/:dispatch_id`
 * (SUPERADMIN/ADMIN).
 */
@Controller()
export class DispatchHistoryController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly history: DispatchHistoryService,
  ) {}

  @MessagePattern({ cmd: 'notification.dispatch_history.list' })
  list(
    @Payload()
    data: {
      page?: number;
      limit?: number;
      status?: string;
      type?: string;
      created_by?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.history.list(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'notification.dispatch_history.get' })
  get(
    @Payload() data: { dispatch_id?: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.history.detail(data?.dispatch_id, data ?? {}),
    );
  }
}
