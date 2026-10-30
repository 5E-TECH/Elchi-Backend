import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { CashboxReceiptService } from './cashbox-receipt.service';

/**
 * T3 (QlLf33Ma) — kassa cheki (gateway: `/finance/receipt-settings`,
 * `/finance/receipts`).
 */
@Controller()
export class CashboxReceiptController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly receipts: CashboxReceiptService,
  ) {}

  @MessagePattern({ cmd: 'finance.receipt.settings.get' })
  getSettings(@Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.getSettings(),
    );
  }

  @MessagePattern({ cmd: 'finance.receipt.settings.update' })
  updateSettings(
    @Payload() data: Parameters<CashboxReceiptService['updateSettings']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.updateSettings(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.receipt.upload_check' })
  uploadCheck(
    @Payload() data: Parameters<CashboxReceiptService['uploadCheck']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.uploadCheck(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.receipt.create_draft' })
  createDraft(
    @Payload() data: Parameters<CashboxReceiptService['createDraft']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.createDraft(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.receipt.ai_result' })
  applyAiResult(
    @Payload() data: Parameters<CashboxReceiptService['applyAiResult']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.applyAiResult(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.receipt.reanalyze' })
  requestReanalyze(
    @Payload() data: Parameters<CashboxReceiptService['requestReanalyze']>[0],
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.receipts.requestReanalyze(data ?? {}),
    );
  }
}
