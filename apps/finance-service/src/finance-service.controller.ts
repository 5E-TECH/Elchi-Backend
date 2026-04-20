import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { CreateCashboxDto } from './dto/cashbox/create-cashbox.dto';
import { FindCashboxByUserDto } from './dto/cashbox/find-cashbox-by-user.dto';
import { UpdateCashboxBalanceDto } from './dto/cashbox/update-cashbox-balance.dto';
import { FindHistoryDto } from './dto/history/find-history.dto';
import { OpenShiftDto } from './dto/shift/open-shift.dto';
import { CloseShiftDto } from './dto/shift/close-shift.dto';
import { FindShiftsDto } from './dto/shift/find-shifts.dto';
import { CreateSalaryDto } from './dto/salary/create-salary.dto';
import { UpdateSalaryDto } from './dto/salary/update-salary.dto';
import { FindSalaryByUserDto } from './dto/salary/find-salary-by-user.dto';

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
      const result = await handler();
      this.rmqService.ack(context);
      return result;
    } catch (error) {
      this.rmqService.nack(context);
      throw error;
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

  @MessagePattern({ cmd: 'finance.cashbox.create' })
  createCashbox(
    @Payload() data: CreateCashboxDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.createCashbox(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.find_by_user' })
  findCashboxByUser(
    @Payload() data: FindCashboxByUserDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.findCashboxByUser(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.main' })
  getMainCashbox(
    @Payload() data: { fromDate?: string; toDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.getMainCashbox({ fromDate: data?.fromDate, toDate: data?.toDate }),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.user_by_id' })
  getCashboxByUserId(
    @Payload()
    data: { id: string; fromDate?: string; toDate?: string; cashbox_type?: any },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.getCashboxByUserId(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.my' })
  myCashbox(
    @Payload() data: { user_id: string; roles?: string[]; fromDate?: string; toDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.myCashbox(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.update_balance' })
  updateBalance(
    @Payload() data: UpdateCashboxBalanceDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.updateBalance(data));
  }

  @MessagePattern({ cmd: 'finance.history.find_all' })
  findAllHistory(
    @Payload() data: FindHistoryDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.findAllHistory(data));
  }

  @MessagePattern({ cmd: 'finance.history.find_by_id' })
  findHistoryById(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.findHistoryById(data.id));
  }

  @MessagePattern({ cmd: 'finance.cashbox.payment_courier' })
  paymentFromCourier(
    @Payload()
    data: {
      courier_id: string;
      amount: number;
      payment_method: any;
      payment_date?: string;
      comment?: string;
      market_id?: string;
      created_by?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.paymentsFromCourier(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.payment_market' })
  paymentToMarket(
    @Payload()
    data: {
      market_id: string;
      amount: number;
      payment_method: any;
      payment_date?: string;
      comment?: string;
      created_by?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.paymentsToMarket(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.all_info' })
  allCashboxesInfo(
    @Payload()
    data: {
      operationType?: any;
      sourceType?: any;
      createdBy?: string;
      cashboxType?: any;
      fromDate?: string;
      toDate?: string;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.allCashboxesTotal(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.financial_balance' })
  financialBalance(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.financeService.financialBalance());
  }

  @MessagePattern({ cmd: 'finance.cashbox.spend' })
  spendMoney(
    @Payload()
    data: { user_id: string; amount: number; type?: any; comment?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.spendMoney(data));
  }

  @MessagePattern({ cmd: 'finance.cashbox.fill' })
  fillCashbox(
    @Payload()
    data: { user_id: string; amount: number; type?: any; comment?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.fillTheCashbox(data));
  }

  @MessagePattern({ cmd: 'finance.shift.open' })
  openShift(
    @Payload() data: OpenShiftDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.openShift(data));
  }

  @MessagePattern({ cmd: 'finance.shift.close' })
  closeShift(
    @Payload() data: CloseShiftDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.closeShift(data));
  }

  @MessagePattern({ cmd: 'finance.shift.find_all' })
  findAllShifts(
    @Payload() data: FindShiftsDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.findAllShifts(data));
  }

  @MessagePattern({ cmd: 'finance.salary.create' })
  createSalary(
    @Payload() data: CreateSalaryDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.createSalary(data));
  }

  @MessagePattern({ cmd: 'finance.salary.update' })
  updateSalary(
    @Payload() data: UpdateSalaryDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.updateSalary(data));
  }

  @MessagePattern({ cmd: 'finance.salary.find_by_user' })
  findSalaryByUser(
    @Payload() data: FindSalaryByUserDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.financeService.findSalaryByUser(data));
  }
}
