import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { FinanceServiceService } from './finance-service.service';

@Controller()
export class FinanceServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly financeService: FinanceServiceService,
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

  @MessagePattern({ cmd: 'finance.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'finance-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- Cashbox ---
  @MessagePattern({ cmd: 'finance.cashbox.create' })
  createCashbox(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.cashbox.find_by_user' })
  findCashboxByUser(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.cashbox.update_balance' })
  updateBalance(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- CashboxHistory ---
  @MessagePattern({ cmd: 'finance.history.find_all' })
  findAllHistory(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- Shift ---
  @MessagePattern({ cmd: 'finance.shift.open' })
  openShift(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.shift.close' })
  closeShift(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.shift.find_all' })
  findAllShifts(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- Salary ---
  @MessagePattern({ cmd: 'finance.salary.create' })
  createSalary(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.salary.update' })
  updateSalary(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'finance.salary.find_by_user' })
  findSalaryByUser(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
