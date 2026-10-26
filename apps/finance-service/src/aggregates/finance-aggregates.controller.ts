import { Controller, HttpException } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  FinanceDailyService,
  type HistoryDailyInput,
} from './finance-daily.service';
import { PaymentsMetaService } from './payments-meta.service';

/**
 * Xatolar RpcException'ga o'raladi (400 — noto'g'ri so'rov, qolgani 500):
 * aks holda RMQ xabarni "vaqtinchalik xato" deb qayta navbatga qo'yardi.
 */
async function rpcSafe<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof RpcException) throw error;
    if (error instanceof HttpException) {
      throw new RpcException({
        statusCode: error.getStatus(),
        message: error.message,
      });
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}

/**
 * qzjTMWPb / uzWcMR1C — moliya o'qish agregatlari (faqat o'qish, pul
 * harakati yo'q). Rol doirasi gateway'da (finance-gateway.controller.ts).
 */
@Controller()
export class FinanceAggregatesController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly daily: FinanceDailyService,
    private readonly paymentsMeta: PaymentsMetaService,
  ) {}

  @MessagePattern({ cmd: 'finance.history.daily' })
  historyDaily(@Payload() data: HistoryDailyInput, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      rpcSafe(() => this.daily.historyDaily(data ?? {})),
    );
  }

  @MessagePattern({ cmd: 'finance.financial_balance.daily' })
  financialBalanceDaily(
    @Payload() data: { from_date?: string; to_date?: string },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      rpcSafe(() => this.daily.financialBalanceDaily(data ?? {})),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.payments_meta' })
  cashboxPaymentsMeta(
    @Payload() data: { hq_courier_ids?: string[]; top?: number },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      rpcSafe(() => this.paymentsMeta.paymentsMeta(data ?? {})),
    );
  }
}
