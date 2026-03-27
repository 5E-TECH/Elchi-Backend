import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { InvestorServiceService } from './investor-service.service';

@Controller()
export class InvestorServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly investorService: InvestorServiceService,
  ) {}

  private async executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await handler();
    } finally {
      this.rmqService.ack(context);
    }
  }

  @MessagePattern({ cmd: 'investor.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'investor-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- Investor ---
  @MessagePattern({ cmd: 'investor.create' })
  create(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.createInvestor(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'investor.find_all' })
  findAll(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findAllInvestors(data?.query ?? data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.find_by_id' })
  findById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findInvestorById(String(data?.id ?? data?.investor_id)),
    );
  }

  @MessagePattern({ cmd: 'investor.update' })
  update(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.updateInvestor(String(data?.id), data?.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.delete' })
  remove(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.deleteInvestor(String(data?.id ?? data?.investor_id)),
    );
  }

  // --- Investment ---
  @MessagePattern({ cmd: 'investor.investment.create' })
  createInvestment(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.createInvestment(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.find_all' })
  findAllInvestments(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findAllInvestments(data?.query ?? data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.find_by_investor' })
  findInvestmentsByInvestor(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findInvestmentsByInvestor(
        String(data?.investor_id ?? data?.id),
        data?.query ?? data ?? {},
      ),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.update' })
  updateInvestment(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.updateInvestment(String(data?.id), data?.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.delete' })
  deleteInvestment(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.deleteInvestment(String(data?.id)),
    );
  }

  // --- ProfitShare ---
  @MessagePattern({ cmd: 'investor.profit.create' })
  createProfit(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.createProfitShare(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'investor.profit.calculate' })
  calculateProfit(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.calculateProfit(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'investor.profit.find_all' })
  findAllProfits(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findAllProfits(data?.query ?? data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.profit.find_by_investor' })
  findProfitByInvestor(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findProfitByInvestor(
        String(data?.investor_id ?? data?.id),
        data?.query ?? data ?? {},
      ),
    );
  }

  @MessagePattern({ cmd: 'investor.profit.mark_paid' })
  markPaid(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.markProfitPaid(String(data?.id ?? data?.profit_id)),
    );
  }
}
