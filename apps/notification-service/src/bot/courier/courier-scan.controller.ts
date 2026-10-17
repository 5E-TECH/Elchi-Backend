import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { CourierScanSummaryService } from './courier-scan-summary.service';

/** Gateway `POST /telegram/scan/done` uzatadigan RPC nomi. */
export const SCAN_DONE_PATTERN = 'notification.telegram.scan_done';

/**
 * (MWYaqprw #6) Skan Mini App'i "✅ Tayyor" → botga xulosa xabari.
 * `courier_id` faqat gateway'dagi JWT'dan keladi (body'dan emas).
 */
@Controller()
export class CourierScanController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly summary: CourierScanSummaryService,
  ) {}

  @MessagePattern({ cmd: SCAN_DONE_PATTERN })
  scanDone(
    @Payload() data: { courier_id?: string; order_ids?: string[] },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.summary.summarize(data ?? {}),
    );
  }
}
