import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { ActivityLogQuery, RmqService, executeAndAck } from '@app/common';
import { InvestorServiceService } from './investor-service.service';
import { CreateInvestorDto } from './dto/create-investor.dto';
import { UpdateInvestorDto } from './dto/update-investor.dto';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { CreateProfitShareDto } from './dto/create-profit-share.dto';
import { CalculateProfitDto } from './dto/calculate-profit.dto';

@Controller()
export class InvestorServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly investorService: InvestorServiceService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  private unwrapDto<T>(payload: T | { dto: T }): T {
    if (payload && typeof payload === 'object' && 'dto' in (payload as { dto?: T })) {
      return (payload as { dto: T }).dto;
    }
    return payload as T;
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
  create(
    @Payload()
    data:
      | { dto: CreateInvestorDto; requester?: { id?: string; roles?: string[] } }
      | CreateInvestorDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.createInvestor(
        this.unwrapDto(data),
        (data as { requester?: { id?: string; roles?: string[] } })?.requester,
      ),
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
  update(
    @Payload()
    data: { id: string; dto: UpdateInvestorDto; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.updateInvestor(String(data?.id), data?.dto ?? {}, data?.requester),
    );
  }

  @MessagePattern({ cmd: 'investor.delete' })
  remove(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.deleteInvestor(
        String(data?.id ?? data?.investor_id),
        data?.requester,
      ),
    );
  }

  // --- Investment ---
  @MessagePattern({ cmd: 'investor.investment.create' })
  createInvestment(
    @Payload()
    data:
      | { dto: CreateInvestmentDto; requester?: { id?: string; roles?: string[] } }
      | CreateInvestmentDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.createInvestment(
        this.unwrapDto(data),
        (data as { requester?: { id?: string; roles?: string[] } })?.requester,
      ),
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

  @MessagePattern({ cmd: 'investor.investment.find_by_id' })
  findInvestmentById(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.findInvestmentById(String(data?.id)),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.update' })
  updateInvestment(
    @Payload()
    data: { id: string; dto: UpdateInvestmentDto; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.updateInvestment(String(data?.id), data?.dto ?? {}, data?.requester),
    );
  }

  @MessagePattern({ cmd: 'investor.investment.delete' })
  deleteInvestment(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.investorService.deleteInvestment(String(data?.id), data?.requester),
    );
  }

  // --- ProfitShare ---
  @MessagePattern({ cmd: 'investor.profit.create' })
  createProfit(
    @Payload()
    data:
      | { dto: CreateProfitShareDto; requester?: { id?: string; roles?: string[] } }
      | CreateProfitShareDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.createProfitShare(
        this.unwrapDto(data),
        (data as { requester?: { id?: string; roles?: string[] } })?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'investor.profit.calculate' })
  calculateProfit(
    @Payload()
    data:
      | { dto: CalculateProfitDto; requester?: { id?: string; roles?: string[] } }
      | CalculateProfitDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.calculateProfit(
        this.unwrapDto(data),
        (data as { requester?: { id?: string; roles?: string[] } })?.requester,
      ),
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
      this.investorService.markProfitPaid(
        String(data?.id ?? data?.profit_id),
        data?.requester,
      ),
    );
  }

  // --- Audit log (read-only fan-in for the gateway) ---
  @MessagePattern({ cmd: 'investor.activity_log.find_all' })
  findActivityLogs(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'investor.activity_log.find_by_entity' })
  findActivityLogsByEntity(
    @Payload() data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.investorService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
