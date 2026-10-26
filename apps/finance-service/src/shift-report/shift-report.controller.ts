import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { ShiftReportService } from './shift-report.service';

/**
 * gWI4gYkw — smena hisobotini qayta yuborish (gateway
 * `POST /finance/shift/:id/report/resend`, faqat SUPERADMIN). Yetkazish
 * ro'yxati — `finance.shift.report` javobidagi `deliveries`.
 */
@Controller()
export class ShiftReportController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly reports: ShiftReportService,
  ) {}

  @MessagePattern({ cmd: 'finance.shift.report.resend' })
  resend(
    @Payload() data: Parameters<ShiftReportService['resend']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.reports.resend(data ?? {}),
    );
  }

  /** Gateway notification-service'dan o'qigan holatlarni saqlaydi. */
  @MessagePattern({ cmd: 'finance.shift.report.deliveries.sync' })
  syncDeliveries(
    @Payload()
    data: Parameters<ShiftReportService['applyDeliveryStatuses']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.reports.applyDeliveryStatuses(data ?? {}),
    );
  }
}
