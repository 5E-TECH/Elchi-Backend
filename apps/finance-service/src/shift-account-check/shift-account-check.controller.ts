import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { ShiftAccountCheckService } from './shift-account-check.service';

/**
 * kiZgTybn — smena yopishda karta qoldig'ini tasdiqlash (gateway:
 * `/finance/shift/account-photo`, `/finance/shift/settings`). Hisobot —
 * `finance.shift.report` (FinanceServiceController).
 */
@Controller()
export class ShiftAccountCheckController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly checks: ShiftAccountCheckService,
  ) {}

  @MessagePattern({ cmd: 'finance.shift.settings.get' })
  getSettings(
    @Payload() data: { cashbox_user_id?: string } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.checks.getSettings(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.settings.update' })
  updateSettings(
    @Payload() data: Parameters<ShiftAccountCheckService['updateSettings']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.checks.updateSettings(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.account_check.attach_photo' })
  attachPhoto(
    @Payload() data: Parameters<ShiftAccountCheckService['attachPhoto']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.checks.attachPhoto(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.account_check.ai_result' })
  applyAiResult(
    @Payload() data: Parameters<ShiftAccountCheckService['applyAiResult']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.checks.applyAiResult(data ?? {}),
    );
  }
}
