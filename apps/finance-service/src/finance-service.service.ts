import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { UserSalary } from './entities/user-salary.entity';
import { Cashbox_type, Operation_type, PaymentMethod, Source_type } from '@app/common';
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
@Injectable()
export class FinanceServiceService {
  constructor(
    @InjectRepository(Cashbox) private readonly cashboxRepo: Repository<Cashbox>,
    @InjectRepository(CashboxHistory)
    private readonly historyRepo: Repository<CashboxHistory>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(UserSalary)
    private readonly salaryRepo: Repository<UserSalary>,
  ) {}

  private successRes(data: any, code = 200, message = 'success') {
    return {
      statusCode: code,
      message,
      data,
    };
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }

    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }

    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }

    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private assertBigIntId(value: string | undefined, fieldName: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(`${fieldName} must be a bigint-like numeric string`);
    }
  }

  private assertPositiveAmount(value: number, fieldName = 'amount') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(`${fieldName} must be greater than 0`);
    }
  }

  private parseDate(value?: string | null): Date | undefined {
    if (!value) {
      return undefined;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid date format: ${value}`);
    }

    return date;
  }

  private normalizeBalance(cashbox: Cashbox) {
    cashbox.balance = Number(cashbox.balance_cash) + Number(cashbox.balance_card);
  }

  private async getCashboxBySelector(selector: {
    cashbox_id?: string;
    user_id?: string;
    cashbox_type?: Cashbox_type;
  }) {
    if (selector.cashbox_id) {
      this.assertBigIntId(selector.cashbox_id, 'cashbox_id');
      const byId = await this.cashboxRepo.findOne({
        where: { id: selector.cashbox_id },
      });
      if (!byId) {
        throw new NotFoundException('Cashbox not found');
      }
      return byId;
    }

    if (!selector.user_id || !selector.cashbox_type) {
      throw new BadRequestException(
        'Either cashbox_id OR (user_id + cashbox_type) is required',
      );
    }

    this.assertBigIntId(selector.user_id, 'user_id');
    const byUserType = await this.cashboxRepo.findOne({
      where: {
        user_id: selector.user_id,
        cashbox_type: selector.cashbox_type,
      },
    });

    if (!byUserType) {
      throw new NotFoundException('Cashbox not found');
    }

    return byUserType;
  }

  private updateBalancesByMethod(
    cashbox: Cashbox,
    amount: number,
    operation: Operation_type,
    method: PaymentMethod,
  ) {
    const sign = operation === Operation_type.INCOME ? 1 : -1;

    if (method === PaymentMethod.CASH) {
      const nextCash = Number(cashbox.balance_cash) + sign * amount;
      if (nextCash < 0) {
        throw new BadRequestException('Insufficient cash balance');
      }
      cashbox.balance_cash = nextCash;
    } else {
      const nextCard = Number(cashbox.balance_card) + sign * amount;
      if (nextCard < 0) {
        throw new BadRequestException('Insufficient card balance');
      }
      cashbox.balance_card = nextCard;
    }

    this.normalizeBalance(cashbox);
  }

  async createCashbox(dto: CreateCashboxDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const exists = await this.cashboxRepo.findOne({
        where: {
          user_id: dto.user_id,
          cashbox_type: dto.cashbox_type,
        },
      });

      if (exists) {
        throw new BadRequestException('Cashbox already exists for this user and type');
      }

      const balanceCash = Number(dto.balance_cash ?? 0);
      const balanceCard = Number(dto.balance_card ?? 0);
      const balance =
        dto.balance !== undefined
          ? Number(dto.balance)
          : Number(balanceCash) + Number(balanceCard);

      const entity = this.cashboxRepo.create({
        user_id: dto.user_id,
        cashbox_type: dto.cashbox_type,
        balance_cash: balanceCash,
        balance_card: balanceCard,
        balance,
      });

      const saved = await this.cashboxRepo.save(entity);
      return this.successRes(saved, 201, 'Cashbox created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findCashboxByUser(dto: FindCashboxByUserDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const page = dto.page && dto.page > 0 ? dto.page : 1;
      const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;

      if (dto.cashbox_type) {
        const cashbox = await this.cashboxRepo.findOne({
          where: {
            user_id: dto.user_id,
            cashbox_type: dto.cashbox_type,
          },
        });

        if (!cashbox) {
          throw new NotFoundException('Cashbox not found');
        }

        if (!dto.with_history) {
          return this.successRes(cashbox, 200, 'Cashbox found');
        }

        const [history, total] = await this.historyRepo.findAndCount({
          where: { cashbox_id: cashbox.id },
          order: { createdAt: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });

        return this.successRes(
          {
            cashbox,
            history,
            pagination: {
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            },
          },
          200,
          'Cashbox found',
        );
      }

      const all = await this.cashboxRepo.find({
        where: { user_id: dto.user_id },
        order: { createdAt: 'DESC' },
      });

      return this.successRes(all, 200, 'Cashboxes found');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateBalance(dto: UpdateCashboxBalanceDto) {
    try {
      this.assertPositiveAmount(Number(dto.amount));

      const paymentMethod = dto.payment_method ?? PaymentMethod.CASH;
      const cashbox = await this.getCashboxBySelector({
        cashbox_id: dto.cashbox_id,
        user_id: dto.user_id,
        cashbox_type: dto.cashbox_type,
      });

      this.updateBalancesByMethod(
        cashbox,
        Number(dto.amount),
        dto.operation_type,
        paymentMethod,
      );

      const savedCashbox = await this.cashboxRepo.save(cashbox);

      const history = this.historyRepo.create({
        operation_type: dto.operation_type,
        cashbox_id: savedCashbox.id,
        source_type: dto.source_type,
        source_id: dto.source_id ?? null,
        source_user_id: dto.source_user_id ?? null,
        amount: Number(dto.amount),
        balance_after: savedCashbox.balance,
        payment_method: paymentMethod,
        comment: dto.comment ?? null,
        created_by: dto.created_by ?? null,
        payment_date:
          dto.payment_date != null
            ? this.parseDate(String(dto.payment_date)) ?? null
            : null,
      });

      const savedHistory = await this.historyRepo.save(history);

      return this.successRes(
        {
          cashbox: savedCashbox,
          history: savedHistory,
        },
        200,
        'Cashbox balance updated',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllHistory(dto: FindHistoryDto) {
    try {
      const page = dto.page && dto.page > 0 ? dto.page : 1;
      const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;

      const where: FindOptionsWhere<CashboxHistory> = {};

      if (dto.cashbox_id) {
        this.assertBigIntId(dto.cashbox_id, 'cashbox_id');
        where.cashbox_id = dto.cashbox_id;
      }
      if (dto.operation_type) {
        where.operation_type = dto.operation_type;
      }
      if (dto.source_type) {
        where.source_type = dto.source_type;
      }
      if (dto.created_by) {
        this.assertBigIntId(dto.created_by, 'created_by');
        where.created_by = dto.created_by;
      }

      const from = this.parseDate(dto.from_date);
      const to = this.parseDate(dto.to_date);

      if (from && to) {
        where.createdAt = Between(from, to);
      } else if (from) {
        where.createdAt = MoreThanOrEqual(from);
      } else if (to) {
        where.createdAt = LessThanOrEqual(to);
      }

      if (dto.user_id) {
        this.assertBigIntId(dto.user_id, 'user_id');
        const userCashboxes = await this.cashboxRepo.find({
          where: { user_id: dto.user_id },
          select: ['id'],
        });

        if (!userCashboxes.length) {
          return this.successRes(
            {
              items: [],
              pagination: {
                total: 0,
                page,
                limit,
                totalPages: 0,
              },
            },
            200,
            'Cashbox histories',
          );
        }

        where.cashbox_id = userCashboxes.map((c) => c.id as any) as any;
      }

      const [items, total] = await this.historyRepo.findAndCount({
        where,
        relations: ['cashbox'],
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      return this.successRes(
        {
          items,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Cashbox histories',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async openShift(dto: OpenShiftDto) {
    try {
      this.assertBigIntId(dto.opened_by, 'opened_by');

      const openShift = await this.shiftRepo.findOne({
        where: { opened_by: dto.opened_by, status: ShiftStatus.OPEN },
      });

      if (openShift) {
        throw new BadRequestException('An open shift already exists for this user');
      }

      const shift = this.shiftRepo.create({
        opened_by: dto.opened_by,
        opened_at: new Date(),
        status: ShiftStatus.OPEN,
        opening_balance_cash: Number(dto.opening_balance_cash ?? 0),
        opening_balance_card: Number(dto.opening_balance_card ?? 0),
        comment: dto.comment ?? null,
      });

      const saved = await this.shiftRepo.save(shift);
      return this.successRes(saved, 201, 'Shift opened');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async closeShift(dto: CloseShiftDto) {
    try {
      this.assertBigIntId(dto.closed_by, 'closed_by');

      let shift: Shift | null = null;

      if (dto.shift_id) {
        this.assertBigIntId(dto.shift_id, 'shift_id');
        shift = await this.shiftRepo.findOne({ where: { id: dto.shift_id } });
      } else if (dto.opened_by) {
        this.assertBigIntId(dto.opened_by, 'opened_by');
        shift = await this.shiftRepo.findOne({
          where: {
            opened_by: dto.opened_by,
            status: ShiftStatus.OPEN,
          },
          order: { opened_at: 'DESC' },
        });
      }

      if (!shift) {
        throw new NotFoundException('Open shift not found');
      }

      if (shift.status !== ShiftStatus.OPEN) {
        throw new BadRequestException('Shift is already closed');
      }

      const closeTime = new Date();
      const histories = await this.historyRepo.find({
        where: {
          createdAt: Between(shift.opened_at, closeTime),
        },
      });

      let totalIncomeCash = 0;
      let totalIncomeCard = 0;
      let totalExpenseCash = 0;
      let totalExpenseCard = 0;

      for (const h of histories) {
        if (h.operation_type === Operation_type.INCOME) {
          if (h.payment_method === PaymentMethod.CASH) {
            totalIncomeCash += Number(h.amount);
          } else {
            totalIncomeCard += Number(h.amount);
          }
        } else if (h.operation_type === Operation_type.EXPENSE) {
          if (h.payment_method === PaymentMethod.CASH) {
            totalExpenseCash += Number(h.amount);
          } else {
            totalExpenseCard += Number(h.amount);
          }
        }
      }

      shift.closed_by = dto.closed_by;
      shift.closed_at = closeTime;
      shift.status = ShiftStatus.CLOSED;
      shift.total_income_cash = totalIncomeCash;
      shift.total_income_card = totalIncomeCard;
      shift.total_expense_cash = totalExpenseCash;
      shift.total_expense_card = totalExpenseCard;
      shift.closing_balance_cash = Number(dto.closing_balance_cash ?? 0);
      shift.closing_balance_card = Number(dto.closing_balance_card ?? 0);
      shift.comment = dto.comment ?? shift.comment;

      const saved = await this.shiftRepo.save(shift);
      return this.successRes(saved, 200, 'Shift closed');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllShifts(dto: FindShiftsDto) {
    try {
      const page = dto.page && dto.page > 0 ? dto.page : 1;
      const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;

      const where: FindOptionsWhere<Shift> = {};

      if (dto.opened_by) {
        this.assertBigIntId(dto.opened_by, 'opened_by');
        where.opened_by = dto.opened_by;
      }
      if (dto.status) {
        where.status = dto.status;
      }

      const from = this.parseDate(dto.from_date);
      const to = this.parseDate(dto.to_date);
      if (from && to) {
        where.opened_at = Between(from, to);
      } else if (from) {
        where.opened_at = MoreThanOrEqual(from);
      } else if (to) {
        where.opened_at = LessThanOrEqual(to);
      }

      const [items, total] = await this.shiftRepo.findAndCount({
        where,
        order: { opened_at: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      return this.successRes(
        {
          items,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Shifts list',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async createSalary(dto: CreateSalaryDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');
      this.assertPositiveAmount(Number(dto.salary_amount), 'salary_amount');

      const existing = await this.salaryRepo.findOne({
        where: { user_id: dto.user_id },
      });
      if (existing) {
        throw new BadRequestException('Salary row already exists for this user');
      }

      const paymentDay = Number(dto.payment_day ?? 1);
      if (paymentDay < 1 || paymentDay > 31) {
        throw new BadRequestException('payment_day must be between 1 and 31');
      }

      const salary = this.salaryRepo.create({
        user_id: dto.user_id,
        salary_amount: Number(dto.salary_amount),
        have_to_pay:
          dto.have_to_pay !== undefined
            ? Number(dto.have_to_pay)
            : Number(dto.salary_amount),
        payment_day: paymentDay,
      });

      const saved = await this.salaryRepo.save(salary);
      return this.successRes(saved, 201, 'Salary created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateSalary(dto: UpdateSalaryDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const salary = await this.salaryRepo.findOne({ where: { user_id: dto.user_id } });
      if (!salary) {
        throw new NotFoundException('Salary not found for this user');
      }

      if (dto.salary_amount !== undefined) {
        this.assertPositiveAmount(Number(dto.salary_amount), 'salary_amount');
        salary.salary_amount = Number(dto.salary_amount);
      }
      if (dto.have_to_pay !== undefined) {
        salary.have_to_pay = Number(dto.have_to_pay);
      }
      if (dto.increase_have_to_pay_by !== undefined) {
        salary.have_to_pay += Number(dto.increase_have_to_pay_by);
      }
      if (dto.payment_day !== undefined) {
        const paymentDay = Number(dto.payment_day);
        if (paymentDay < 1 || paymentDay > 31) {
          throw new BadRequestException('payment_day must be between 1 and 31');
        }
        salary.payment_day = paymentDay;
      }

      const saved = await this.salaryRepo.save(salary);
      return this.successRes(saved, 200, 'Salary updated');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findSalaryByUser(data: FindSalaryByUserDto) {
    try {
      this.assertBigIntId(data.user_id, 'user_id');

      const salary = await this.salaryRepo.findOne({
        where: { user_id: data.user_id },
      });

      if (!salary) {
        throw new NotFoundException('Salary not found for this user');
      }

      return this.successRes(salary, 200, 'Salary found');
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
