import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { UserSalary } from './entities/user-salary.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import {
  ActivityAction,
  ActivityLogService,
  Cashbox_type,
  Commission_type,
  FinancialSource_type,
  Operation_type,
  Order_status,
  PaymentMethod,
  Source_type,
  rmqSend,
} from '@app/common';
import { ClientProxy } from '@nestjs/microservices';
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
export class FinanceServiceService implements OnModuleInit {
  private static readonly MAIN_CASHBOX_USER_ID = '0';
  private readonly logger = new Logger(FinanceServiceService.name);

  constructor(
    @InjectRepository(Cashbox)
    private readonly cashboxRepo: Repository<Cashbox>,
    @InjectRepository(CashboxHistory)
    private readonly historyRepo: Repository<CashboxHistory>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(UserSalary)
    private readonly salaryRepo: Repository<UserSalary>,
    @InjectRepository(OperatorEarning)
    private readonly earningRepo: Repository<OperatorEarning>,
    @InjectRepository(OperatorPayment)
    private readonly paymentRepo: Repository<OperatorPayment>,
    @InjectRepository(FinancialBalanceHistory)
    private readonly financialHistoryRepo: Repository<FinancialBalanceHistory>,
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  async onModuleInit() {
    const main = await this.cashboxRepo.findOne({
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
    });

    if (!main) {
      const entity = this.cashboxRepo.create({
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      });
      await this.cashboxRepo.save(entity);
    }
  }

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
      throw new BadRequestException(
        `${fieldName} must be a bigint-like numeric string`,
      );
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
    cashbox.balance =
      Number(cashbox.balance_cash) + Number(cashbox.balance_card);
  }

  private async ensureMainCashbox() {
    const main = await this.cashboxRepo.findOne({
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
    });
    if (!main) {
      const created = this.cashboxRepo.create({
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      });
      return this.cashboxRepo.save(created);
    }
    return main;
  }

  private calcIncomeOutcome(histories: CashboxHistory[]) {
    let income = 0;
    let outcome = 0;
    for (const history of histories) {
      if (history.operation_type === Operation_type.INCOME) {
        income += Number(history.amount);
      } else {
        outcome += Number(history.amount);
      }
    }
    return { income, outcome };
  }

  private parseDateRange(fromDate?: string, toDate?: string) {
    const start = this.parseDate(fromDate ?? null);
    const end = this.parseDate(toDate ?? null);
    return { start, end };
  }

  private async findMarketPayableOrders(marketId: string) {
    const partly = await rmqSend<{ data: any[] }>(
      this.orderClient,
      { cmd: 'order.find_all' },
      {
        query: {
          market_id: marketId,
          status: Order_status.PARTLY_PAID,
          page: 1,
          limit: 1000,
        },
      },
    ).catch(() => ({ data: [] }));

    const sold = await rmqSend<{ data: any[] }>(
      this.orderClient,
      { cmd: 'order.find_all' },
      {
        query: {
          market_id: marketId,
          status: Order_status.SOLD,
          page: 1,
          limit: 1000,
        },
      },
    ).catch(() => ({ data: [] }));

    return [...(partly?.data ?? []), ...(sold?.data ?? [])];
  }

  private async applyPaymentToOrders(marketId: string, amount: number) {
    let paymentInProcess = Number(amount);
    if (paymentInProcess <= 0) {
      return;
    }

    const allSoldOrders = await this.findMarketPayableOrders(marketId);
    const partlyPaidOrder = allSoldOrders.find(
      (o) => o.status === Order_status.PARTLY_PAID,
    );

    if (partlyPaidOrder && paymentInProcess > 0) {
      const remaining =
        Number(partlyPaidOrder.to_be_paid ?? 0) -
        Number(partlyPaidOrder.paid_amount ?? 0);
      let paidAmount = Number(partlyPaidOrder.paid_amount ?? 0);
      let nextStatus = Order_status.PARTLY_PAID;

      if (paymentInProcess >= remaining) {
        paymentInProcess -= remaining;
        paidAmount = Number(partlyPaidOrder.to_be_paid ?? 0);
        nextStatus = Order_status.PAID;
      } else {
        paidAmount += paymentInProcess;
        paymentInProcess = 0;
      }

      await rmqSend(
        this.orderClient,
        { cmd: 'order.update_normalized' },
        {
          id: partlyPaidOrder.id,
          dto: { paid_amount: paidAmount, status: nextStatus },
        },
      );
    }

    const soldOrders = allSoldOrders.filter(
      (o) => o.status === Order_status.SOLD,
    );

    for (const order of soldOrders) {
      if (paymentInProcess <= 0) break;
      const orderToBePaid = Number(order.to_be_paid ?? 0);
      let paidAmount = Number(order.paid_amount ?? 0);
      let nextStatus = Order_status.PARTLY_PAID;

      if (paymentInProcess >= orderToBePaid) {
        paymentInProcess -= orderToBePaid;
        paidAmount = orderToBePaid;
        nextStatus = Order_status.PAID;
      } else {
        paidAmount += paymentInProcess;
        paymentInProcess = 0;
      }

      await rmqSend(
        this.orderClient,
        { cmd: 'order.update_normalized' },
        { id: order.id, dto: { paid_amount: paidAmount, status: nextStatus } },
      );
    }
  }

  private async syncMarketPaymentsSafely(marketId: string, amount: number) {
    try {
      await this.applyPaymentToOrders(marketId, amount);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown sync error';
      this.logger.warn(
        `transfer committed, but order sync failed (market_id=${marketId}, amount=${amount}): ${message}`,
      );
    }
  }

  private extractResponseData<T>(response: any): T | null {
    if (response && typeof response === 'object' && 'data' in response) {
      return (response.data ?? null) as T | null;
    }
    return (response ?? null) as T | null;
  }

  private async loadUsersByIds(ids: string[]) {
    const uniqueIds = Array.from(
      new Set(
        ids
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );

    if (!uniqueIds.length) {
      return new Map<string, any>();
    }

    const pairs = await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const response = await rmqSend<any>(
            this.identityClient,
            { cmd: 'identity.user.find_by_id' },
            { id },
          );
          return [id, this.extractResponseData<any>(response)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map<string, any>(pairs);
  }

  private async enrichHistoryWithUsers(histories: CashboxHistory[]) {
    if (!Array.isArray(histories) || !histories.length) {
      return histories;
    }

    const ids: string[] = [];
    for (const history of histories) {
      if (history?.created_by) {
        ids.push(String(history.created_by));
      }
      if (history?.cashbox?.user_id) {
        ids.push(String(history.cashbox.user_id));
      }
    }

    const usersMap = await this.loadUsersByIds(ids);

    return histories.map((history) => {
      const createdByUser =
        history.created_by != null
          ? (usersMap.get(String(history.created_by)) ?? null)
          : null;

      if (!history.cashbox) {
        return {
          ...history,
          createdByUser,
        };
      }

      const cashboxUser = usersMap.get(String(history.cashbox.user_id)) ?? null;

      return {
        ...history,
        createdByUser,
        cashbox: {
          ...history.cashbox,
          user: cashboxUser,
        },
      };
    });
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

  private async getCashboxBySelectorWithManager(
    manager: EntityManager,
    selector: {
      cashbox_id?: string;
      user_id?: string;
      cashbox_type?: Cashbox_type;
    },
    options: { lock?: boolean } = {},
  ) {
    // `lock: true` acquires a row-level FOR UPDATE so concurrent updateBalance
    // calls for the same cashbox serialize instead of clobbering each other's
    // in-memory recomputed balance. Only safe inside an active transaction.
    const lock = options.lock
      ? { mode: 'pessimistic_write' as const }
      : undefined;

    if (selector.cashbox_id) {
      this.assertBigIntId(selector.cashbox_id, 'cashbox_id');
      const byId = await manager.findOne(Cashbox, {
        where: { id: selector.cashbox_id },
        lock,
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
    const byUserType = await manager.findOne(Cashbox, {
      where: {
        user_id: selector.user_id,
        cashbox_type: selector.cashbox_type,
      },
      lock,
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
    const allowNegativeBalance =
      cashbox.cashbox_type === Cashbox_type.FOR_MARKET ||
      cashbox.cashbox_type === Cashbox_type.FOR_COURIER;

    if (method === PaymentMethod.CASH) {
      const nextCash = Number(cashbox.balance_cash) + sign * amount;
      if (!allowNegativeBalance && nextCash < 0) {
        throw new BadRequestException('Insufficient cash balance');
      }
      cashbox.balance_cash = nextCash;
    } else {
      const nextCard = Number(cashbox.balance_card) + sign * amount;
      if (!allowNegativeBalance && nextCard < 0) {
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
        throw new BadRequestException(
          'Cashbox already exists for this user and type',
        );
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

      if (!dto.with_history) {
        return this.successRes(all, 200, 'Cashboxes found');
      }

      const [history, total] = await this.historyRepo
        .createQueryBuilder('history')
        .innerJoinAndSelect('history.cashbox', 'cashbox')
        .where('cashbox.user_id = :userId', { userId: dto.user_id })
        .orderBy('history.createdAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();

      return this.successRes(
        {
          cashboxes: all,
          history,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Cashboxes found',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateBalance(dto: UpdateCashboxBalanceDto) {
    try {
      this.assertPositiveAmount(Number(dto.amount));
      const paymentMethod = dto.payment_method ?? PaymentMethod.CASH;
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const cashbox = await this.getCashboxBySelectorWithManager(
          queryRunner.manager,
          {
            cashbox_id: dto.cashbox_id,
            user_id: dto.user_id,
            cashbox_type: dto.cashbox_type,
          },
          { lock: true },
        );

        // Idempotency: if a history row already exists for the same business
        // event (cashbox + source_type + source_id + operation_type), this is
        // a duplicate RMQ delivery — skip the balance mutation and return the
        // already-applied state. The pessimistic lock above guarantees we see
        // committed history from earlier deliveries.
        if (dto.source_id) {
          const existingHistory = await queryRunner.manager.findOne(
            CashboxHistory,
            {
              where: {
                cashbox_id: String(cashbox.id),
                source_type: dto.source_type,
                source_id: String(dto.source_id),
                operation_type: dto.operation_type,
                // Must mirror the IDX_CASHBOX_HISTORY_IDEMPOTENT key exactly,
                // else a fresh attempt (new epoch) would match a prior row and
                // be wrongly skipped.
                dedup_epoch: String(dto.dedup_epoch ?? ''),
              },
            },
          );
          if (existingHistory) {
            await queryRunner.commitTransaction();
            return this.successRes(
              { cashbox, history: existingHistory, idempotent: true },
              200,
              'Cashbox balance already applied (idempotent replay)',
            );
          }
        }

        this.updateBalancesByMethod(
          cashbox,
          Number(dto.amount),
          dto.operation_type,
          paymentMethod,
        );

        const savedCashbox = await queryRunner.manager.save(cashbox);

        const history = queryRunner.manager.create(CashboxHistory, {
          operation_type: dto.operation_type,
          cashbox_id: savedCashbox.id,
          source_type: dto.source_type,
          source_id: dto.source_id ?? null,
          dedup_epoch: String(dto.dedup_epoch ?? ''),
          source_user_id: dto.source_user_id ?? null,
          amount: Number(dto.amount),
          balance_after: savedCashbox.balance,
          balance_cash_after: savedCashbox.balance_cash,
          balance_card_after: savedCashbox.balance_card,
          payment_method: paymentMethod,
          comment: dto.comment ?? null,
          created_by: dto.created_by ?? null,
          proof_files:
            Array.isArray(dto.proof_files) && dto.proof_files.length
              ? dto.proof_files
              : null,
          payment_date:
            dto.payment_date != null
              ? (this.parseDate(String(dto.payment_date)) ?? null)
              : null,
        });

        const savedHistory = await queryRunner.manager.save(history);
        await queryRunner.commitTransaction();

        return this.successRes(
          {
            cashbox: savedCashbox,
            history: savedHistory,
          },
          200,
          'Cashbox balance updated',
        );
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllHistory(dto: FindHistoryDto) {
    try {
      const noPagination = dto.page === 0 || dto.limit === 0;
      const page = noPagination ? 0 : dto.page && dto.page > 0 ? dto.page : 1;
      const limit = noPagination
        ? 0
        : dto.limit && dto.limit > 0
          ? dto.limit
          : 20;
      const historyCashboxType = dto.cashbox_type ?? dto.cashboxType;

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
      if (dto.source_id) {
        this.assertBigIntId(dto.source_id, 'source_id');
        where.source_id = dto.source_id;
      }
      if (dto.created_by) {
        this.assertBigIntId(dto.created_by, 'created_by');
        where.created_by = dto.created_by;
      }
      if (historyCashboxType) {
        const cashboxesByType = await this.cashboxRepo.find({
          where: { cashbox_type: historyCashboxType },
          select: ['id'],
        });
        if (!cashboxesByType.length) {
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
        const typedIds = cashboxesByType.map((cashbox) => cashbox.id);
        if (dto.cashbox_id) {
          if (!typedIds.includes(dto.cashbox_id)) {
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
        } else {
          where.cashbox_id = In(typedIds);
        }
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
          where: {
            user_id: dto.user_id,
            ...(historyCashboxType ? { cashbox_type: historyCashboxType } : {}),
          },
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

        const userCashboxIds = userCashboxes.map((cashbox) => cashbox.id);
        if (dto.cashbox_id) {
          if (!userCashboxIds.includes(dto.cashbox_id)) {
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
        } else {
          where.cashbox_id = In(userCashboxIds);
        }
      }

      const [items, total] = await this.historyRepo.findAndCount({
        where,
        relations: ['cashbox'],
        order: { createdAt: 'DESC' },
        ...(noPagination
          ? {}
          : {
              skip: (page - 1) * limit,
              take: limit,
            }),
      });
      const enrichedItems = await this.enrichHistoryWithUsers(items);

      return this.successRes(
        {
          items: enrichedItems,
          pagination: {
            total,
            page,
            limit,
            totalPages: noPagination
              ? total > 0
                ? 1
                : 0
              : Math.ceil(total / limit),
          },
        },
        200,
        'Cashbox histories',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findHistoryById(id: string) {
    try {
      this.assertBigIntId(id, 'id');

      const history = await this.historyRepo.findOne({
        where: { id },
        relations: ['cashbox'],
      });

      if (!history) {
        throw new NotFoundException('Cashbox history not found');
      }

      const sourceTypesWithOrder = new Set<Source_type>([
        Source_type.SELL,
        Source_type.CANCEL,
        Source_type.EXTRA_COST,
        Source_type.CORRECTION,
      ]);

      let order: any = null;

      if (history.source_id && sourceTypesWithOrder.has(history.source_type)) {
        const orderResponse = await rmqSend<any>(
          this.orderClient,
          { cmd: 'order.find_by_id_enriched' },
          { id: history.source_id },
        ).catch(() => null);

        order = orderResponse?.data ?? orderResponse ?? null;
      }
      const [enrichedHistory] = await this.enrichHistoryWithUsers([history]);

      return this.successRes(
        {
          ...enrichedHistory,
          order,
        },
        200,
        'Cashbox history detail',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async openShift(dto: OpenShiftDto) {
    try {
      this.assertBigIntId(dto.opened_by, 'opened_by');

      // Optimistic pre-check produces a friendlier error message, but is racy.
      // The partial unique index `IDX_SHIFT_OPENED_BY_OPEN_UNIQUE` is the
      // authoritative guard: two concurrent inserts both pass the check but
      // exactly one wins at the DB level; the loser hits 23505 below.
      const openShift = await this.shiftRepo.findOne({
        where: { opened_by: dto.opened_by, status: ShiftStatus.OPEN },
      });

      if (openShift) {
        throw new BadRequestException(
          'An open shift already exists for this user',
        );
      }

      const shift = this.shiftRepo.create({
        opened_by: dto.opened_by,
        opened_at: new Date(),
        status: ShiftStatus.OPEN,
        opening_balance_cash: Number(dto.opening_balance_cash ?? 0),
        opening_balance_card: Number(dto.opening_balance_card ?? 0),
        comment: dto.comment ?? null,
      });

      try {
        const saved = await this.shiftRepo.save(shift);
        return this.successRes(saved, 201, 'Shift opened');
      } catch (insertError) {
        if (
          insertError instanceof QueryFailedError &&
          (insertError as QueryFailedError & { code?: string }).code === '23505'
        ) {
          throw new BadRequestException(
            'An open shift already exists for this user',
          );
        }
        throw insertError;
      }
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async closeShift(dto: CloseShiftDto) {
    try {
      this.assertBigIntId(dto.closed_by, 'closed_by');

      // Pre-locate the shift's id without lock so we can then re-fetch with a
      // row-level lock inside the transaction. Without the lock, two parallel
      // closeShift calls can both pass the status==='open' check and double-write.
      let shiftId: string | null = null;

      if (dto.shift_id) {
        this.assertBigIntId(dto.shift_id, 'shift_id');
        shiftId = String(dto.shift_id);
      } else if (dto.opened_by) {
        this.assertBigIntId(dto.opened_by, 'opened_by');
        const candidate = await this.shiftRepo.findOne({
          where: {
            opened_by: dto.opened_by,
            status: ShiftStatus.OPEN,
          },
          order: { opened_at: 'DESC' },
        });
        shiftId = candidate ? String(candidate.id) : null;
      }

      if (!shiftId) {
        throw new NotFoundException('Open shift not found');
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const shift = await queryRunner.manager.findOne(Shift, {
          where: { id: shiftId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!shift) {
          throw new NotFoundException('Open shift not found');
        }

        if (shift.status !== ShiftStatus.OPEN) {
          throw new BadRequestException('Shift is already closed');
        }

        const closeTime = new Date();
        const histories = await queryRunner.manager.find(CashboxHistory, {
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

        const saved = await queryRunner.manager.save(shift);
        await queryRunner.commitTransaction();
        return this.successRes(saved, 200, 'Shift closed');
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
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
        throw new BadRequestException(
          'Salary row already exists for this user',
        );
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

      const salary = await this.salaryRepo.findOne({
        where: { user_id: dto.user_id },
      });
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

  async getMainCashbox(filters?: { fromDate?: string; toDate?: string }) {
    try {
      const mainCashbox = await this.ensureMainCashbox();
      const { start, end } = this.parseDateRange(
        filters?.fromDate,
        filters?.toDate,
      );
      const where: FindOptionsWhere<CashboxHistory> = {
        cashbox_id: mainCashbox.id,
      };
      if (start && end) where.createdAt = Between(start, end);
      else if (start) where.createdAt = MoreThanOrEqual(start);
      else if (end) where.createdAt = LessThanOrEqual(end);

      const cashboxHistory = await this.historyRepo.find({
        where,
        order: { createdAt: 'DESC' },
      });
      const { income, outcome } = this.calcIncomeOutcome(cashboxHistory);
      return this.successRes(
        { cashbox: mainCashbox, cashboxHistory, income, outcome },
        200,
        'Main cashbox details',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async getCashboxByUserId(data: {
    id: string;
    fromDate?: string;
    toDate?: string;
    cashbox_type?: Cashbox_type;
  }) {
    try {
      this.assertBigIntId(data.id, 'id');
      const where: FindOptionsWhere<Cashbox> = { user_id: data.id };
      if (data.cashbox_type) where.cashbox_type = data.cashbox_type;

      const cashbox = await this.cashboxRepo.findOne({
        where,
        order: { createdAt: 'DESC' },
      });
      if (!cashbox) throw new NotFoundException('Cashbox not found');

      const { start, end } = this.parseDateRange(data.fromDate, data.toDate);
      const historyWhere: FindOptionsWhere<CashboxHistory> = {
        cashbox_id: cashbox.id,
      };
      if (start && end) historyWhere.createdAt = Between(start, end);
      else if (start) historyWhere.createdAt = MoreThanOrEqual(start);
      else if (end) historyWhere.createdAt = LessThanOrEqual(end);

      const cashboxHistory = await this.historyRepo.find({
        where: historyWhere,
        order: { createdAt: 'DESC' },
      });
      const { income, outcome } = this.calcIncomeOutcome(cashboxHistory);

      return this.successRes(
        { cashbox, cashboxHistory, income, outcome },
        200,
        'Cashbox details',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async myCashbox(data: {
    user_id: string;
    branch_id?: string | null;
    roles?: string[];
    fromDate?: string;
    toDate?: string;
  }) {
    try {
      this.assertBigIntId(data.user_id, 'user_id');
      const roles = (data.roles ?? []).map((r) => r.toLowerCase());
      const isManager = roles.includes('manager') && !roles.includes('superadmin') && !roles.includes('admin');
      const cashboxType = roles.includes('market')
        ? Cashbox_type.FOR_MARKET
        : isManager
          ? Cashbox_type.BRANCH
          : Cashbox_type.FOR_COURIER;
      const targetUserId =
        cashboxType === Cashbox_type.BRANCH ? String(data.branch_id ?? '').trim() : data.user_id;
      if (cashboxType === Cashbox_type.BRANCH && !targetUserId) {
        throw new BadRequestException('Manager uchun branch_id majburiy');
      }
      let cashbox = await this.cashboxRepo.findOne({
        where: { user_id: targetUserId, cashbox_type: cashboxType },
        order: { createdAt: 'DESC' },
      });

      if (!cashbox) {
        const created = this.cashboxRepo.create({
          user_id: targetUserId,
          cashbox_type: cashboxType,
          balance: 0,
          balance_cash: 0,
          balance_card: 0,
        });
        cashbox = await this.cashboxRepo.save(created);
      }

      return this.getCashboxByUserId({
        id: targetUserId,
        cashbox_type: cashboxType,
        fromDate: data.fromDate,
        toDate: data.toDate,
      });
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async spendMoney(data: {
    user_id: string;
    amount: number;
    type?: PaymentMethod;
    comment?: string;
    cashbox_type?: Cashbox_type;
  }) {
    try {
      const targetCashboxType = data.cashbox_type ?? Cashbox_type.MAIN;
      const targetUserId =
        targetCashboxType === Cashbox_type.MAIN
          ? FinanceServiceService.MAIN_CASHBOX_USER_ID
          : data.user_id;
      const update = await this.updateBalance({
        user_id: targetUserId,
        amount: data.amount,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.MANUAL_EXPENSE,
        payment_method: data.type ?? PaymentMethod.CASH,
        comment: data.comment,
        created_by: data.user_id,
        cashbox_type: targetCashboxType,
      });
      return this.successRes(update?.data ?? {}, 200, 'Manual expense created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async fillTheCashbox(data: {
    user_id: string;
    amount: number;
    type?: PaymentMethod;
    comment?: string;
    cashbox_type?: Cashbox_type;
  }) {
    try {
      const targetCashboxType = data.cashbox_type ?? Cashbox_type.MAIN;
      const targetUserId =
        targetCashboxType === Cashbox_type.MAIN
          ? FinanceServiceService.MAIN_CASHBOX_USER_ID
          : data.user_id;
      const update = await this.updateBalance({
        user_id: targetUserId,
        amount: data.amount,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.MANUAL_INCOME,
        payment_method: data.type ?? PaymentMethod.CASH,
        comment: data.comment,
        created_by: data.user_id,
        cashbox_type: targetCashboxType,
      });
      return this.successRes(update?.data ?? {}, 200, 'Cashbox filled');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async paymentsFromCourier(data: {
    courier_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    market_id?: string;
    created_by?: string;
    receiver_user_id?: string;
    receiver_cashbox_type?: Cashbox_type;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      this.assertBigIntId(data.courier_id, 'courier_id');
      this.assertPositiveAmount(Number(data.amount));
      if (
        data.payment_method === PaymentMethod.CLICK_TO_MARKET &&
        !data.market_id
      ) {
        throw new BadRequestException(
          "Click_to_market usulida market_id bo'lishi shart va majburiy !!!",
        );
      }

      // Lock order: courier → main → market. Same order in paymentsToMarket
      // and updateBalance to avoid deadlocks across concurrent payments.
      const courierCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: data.courier_id,
          cashbox_type: Cashbox_type.FOR_COURIER,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!courierCashbox)
        throw new NotFoundException('Courier cashbox not found');

      const receiverUserId = String(
        data.receiver_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
      );
      const receiverCashboxType =
        data.receiver_cashbox_type ?? Cashbox_type.MAIN;

      let receiverCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: { user_id: receiverUserId, cashbox_type: receiverCashboxType },
        lock: { mode: 'pessimistic_write' },
      });
      if (!receiverCashbox) {
        receiverCashbox = await queryRunner.manager.save(
          queryRunner.manager.create(Cashbox, {
            user_id: receiverUserId,
            cashbox_type: receiverCashboxType,
            balance: 0,
            balance_cash: 0,
            balance_card: 0,
          }),
        );
      }

      this.updateBalancesByMethod(
        courierCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(courierCashbox);

      const courierHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.EXPENSE,
        cashbox_id: courierCashbox.id,
        source_type: Source_type.COURIER_PAYMENT,
        amount: Number(data.amount),
        balance_after: courierCashbox.balance,
        balance_cash_after: courierCashbox.balance_cash,
        balance_card_after: courierCashbox.balance_card,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
        payment_method: data.payment_method,
        source_user_id: data.courier_id,
      });
      await queryRunner.manager.save(courierHistory);

      this.updateBalancesByMethod(
        receiverCashbox,
        Number(data.amount),
        Operation_type.INCOME,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(receiverCashbox);

      const receiverHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.INCOME,
        cashbox_id: receiverCashbox.id,
        source_type: Source_type.COURIER_PAYMENT,
        amount: Number(data.amount),
        balance_after: receiverCashbox.balance,
        balance_cash_after: receiverCashbox.balance_cash,
        balance_card_after: receiverCashbox.balance_card,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
        payment_method: data.payment_method,
        source_user_id: data.courier_id,
      });
      await queryRunner.manager.save(receiverHistory);

      if (
        data.payment_method === PaymentMethod.CLICK_TO_MARKET &&
        data.market_id
      ) {
        const marketCashbox = await queryRunner.manager.findOne(Cashbox, {
          where: {
            user_id: data.market_id,
            cashbox_type: Cashbox_type.FOR_MARKET,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!marketCashbox)
          throw new NotFoundException('Market cashbox topilmadi');

        this.updateBalancesByMethod(
          receiverCashbox,
          Number(data.amount),
          Operation_type.EXPENSE,
          data.payment_method,
        );
        await queryRunner.manager.save(receiverCashbox);
        await queryRunner.manager.save(
          queryRunner.manager.create(CashboxHistory, {
            operation_type: Operation_type.EXPENSE,
            cashbox_id: receiverCashbox.id,
            source_type: Source_type.MARKET_PAYMENT,
            amount: Number(data.amount),
            balance_after: receiverCashbox.balance,
            balance_cash_after: receiverCashbox.balance_cash,
            balance_card_after: receiverCashbox.balance_card,
            comment: data.comment ?? null,
            created_by: data.created_by ?? null,
            payment_date: this.parseDate(data.payment_date ?? null) ?? null,
            payment_method: data.payment_method,
            source_user_id: data.market_id,
          }),
        );

        this.updateBalancesByMethod(
          marketCashbox,
          Number(data.amount),
          Operation_type.EXPENSE,
          data.payment_method,
        );
        await queryRunner.manager.save(marketCashbox);
        await queryRunner.manager.save(
          queryRunner.manager.create(CashboxHistory, {
            operation_type: Operation_type.EXPENSE,
            cashbox_id: marketCashbox.id,
            source_type: Source_type.MARKET_PAYMENT,
            amount: Number(data.amount),
            balance_after: marketCashbox.balance,
            balance_cash_after: marketCashbox.balance_cash,
            balance_card_after: marketCashbox.balance_card,
            comment: data.comment ?? null,
            created_by: data.created_by ?? null,
            payment_date: this.parseDate(data.payment_date ?? null) ?? null,
            payment_method: data.payment_method,
            source_user_id: data.market_id,
          }),
        );
      }

      await queryRunner.commitTransaction();

      if (
        data.payment_method === PaymentMethod.CLICK_TO_MARKET &&
        data.market_id
      ) {
        await this.syncMarketPaymentsSafely(
          data.market_id,
          Number(data.amount),
        );
      }

      return this.successRes(
        {
          courier_cashbox: {
            id: courierCashbox.id,
            user_id: courierCashbox.user_id,
            cashbox_type: courierCashbox.cashbox_type,
            balance: courierCashbox.balance,
            balance_cash: courierCashbox.balance_cash,
            balance_card: courierCashbox.balance_card,
            updated_at: courierCashbox.updatedAt,
          },
          main_cashbox: {
            id: receiverCashbox.id,
            cashbox_type: receiverCashbox.cashbox_type,
            balance: receiverCashbox.balance,
            balance_cash: receiverCashbox.balance_cash,
            balance_card: receiverCashbox.balance_card,
            updated_at: receiverCashbox.updatedAt,
          },
          receiver_cashbox: {
            id: receiverCashbox.id,
            user_id: receiverCashbox.user_id,
            cashbox_type: receiverCashbox.cashbox_type,
            balance: receiverCashbox.balance,
            balance_cash: receiverCashbox.balance_cash,
            balance_card: receiverCashbox.balance_card,
            updated_at: receiverCashbox.updatedAt,
          },
        },
        201,
        "To'lov qabul qilindi !!! ",
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async paymentFromBranchToMain(data: {
    branch_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    created_by?: string;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      this.assertBigIntId(data.branch_id, 'branch_id');
      this.assertPositiveAmount(Number(data.amount));

      const branchCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: { user_id: data.branch_id, cashbox_type: Cashbox_type.BRANCH },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branchCashbox)
        throw new NotFoundException('Branch cashbox not found');

      let mainCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
          cashbox_type: Cashbox_type.MAIN,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!mainCashbox) {
        mainCashbox = await queryRunner.manager.save(
          queryRunner.manager.create(Cashbox, {
            user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
            cashbox_type: Cashbox_type.MAIN,
            balance: 0,
            balance_cash: 0,
            balance_card: 0,
          }),
        );
      }

      this.updateBalancesByMethod(
        branchCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(branchCashbox);

      const branchHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.EXPENSE,
        cashbox_id: branchCashbox.id,
        source_type: Source_type.BRANCH_TO_MAIN,
        amount: Number(data.amount),
        balance_after: branchCashbox.balance,
        balance_cash_after: branchCashbox.balance_cash,
        balance_card_after: branchCashbox.balance_card,
        payment_method: data.payment_method ?? PaymentMethod.CASH,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        source_user_id: data.branch_id,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      });
      await queryRunner.manager.save(branchHistory);

      this.updateBalancesByMethod(
        mainCashbox,
        Number(data.amount),
        Operation_type.INCOME,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(mainCashbox);

      const mainHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.INCOME,
        cashbox_id: mainCashbox.id,
        source_type: Source_type.BRANCH_TO_MAIN,
        amount: Number(data.amount),
        balance_after: mainCashbox.balance,
        balance_cash_after: mainCashbox.balance_cash,
        balance_card_after: mainCashbox.balance_card,
        payment_method: data.payment_method ?? PaymentMethod.CASH,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        source_user_id: data.branch_id,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      });
      await queryRunner.manager.save(mainHistory);

      await queryRunner.commitTransaction();
      return this.successRes(
        {
          branch_cashbox: branchCashbox,
          main_cashbox: mainCashbox,
        },
        200,
        'Branch to main payment successful',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async paymentsToMarket(data: {
    market_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    created_by?: string;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      this.assertBigIntId(data.market_id, 'market_id');
      this.assertPositiveAmount(Number(data.amount));

      // Lock order: main → market (same order as paymentsFromCourier to avoid
      // cross-method deadlocks).
      const mainCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
          cashbox_type: Cashbox_type.MAIN,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!mainCashbox) throw new NotFoundException('Main cashbox not found');

      const marketCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: data.market_id,
          cashbox_type: Cashbox_type.FOR_MARKET,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!marketCashbox)
        throw new NotFoundException('Market cashbox not found');

      this.updateBalancesByMethod(
        mainCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(mainCashbox);
      await queryRunner.manager.save(
        queryRunner.manager.create(CashboxHistory, {
          operation_type: Operation_type.EXPENSE,
          cashbox_id: mainCashbox.id,
          source_type: Source_type.MARKET_PAYMENT,
          amount: Number(data.amount),
          balance_after: mainCashbox.balance,
          balance_cash_after: mainCashbox.balance_cash,
          balance_card_after: mainCashbox.balance_card,
          comment: data.comment ?? null,
          created_by: data.created_by ?? null,
          payment_date: this.parseDate(data.payment_date ?? null) ?? null,
          payment_method: data.payment_method,
          source_user_id: data.market_id,
        }),
      );

      this.updateBalancesByMethod(
        marketCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method ?? PaymentMethod.CASH,
      );
      await queryRunner.manager.save(marketCashbox);
      await queryRunner.manager.save(
        queryRunner.manager.create(CashboxHistory, {
          operation_type: Operation_type.EXPENSE,
          cashbox_id: marketCashbox.id,
          source_type: Source_type.MARKET_PAYMENT,
          amount: Number(data.amount),
          balance_after: marketCashbox.balance,
          balance_cash_after: marketCashbox.balance_cash,
          balance_card_after: marketCashbox.balance_card,
          comment: data.comment ?? null,
          created_by: data.created_by ?? null,
          payment_date: this.parseDate(data.payment_date ?? null) ?? null,
          payment_method: data.payment_method,
          source_user_id: data.market_id,
        }),
      );

      await queryRunner.commitTransaction();
      await this.syncMarketPaymentsSafely(data.market_id, Number(data.amount));

      return this.successRes({}, 200, `Marketga ${data.amount} so'm to'landi`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async allCashboxesTotal(filters?: {
    operationType?: Operation_type;
    sourceType?: Source_type;
    createdBy?: string;
    cashboxType?: Cashbox_type;
    fromDate?: string;
    toDate?: string;
    page?: number;
    limit?: number;
  }) {
    try {
      const mainCashbox = await this.ensureMainCashbox();
      const courierCashboxes = await this.cashboxRepo.find({
        where: { cashbox_type: Cashbox_type.FOR_COURIER },
      });
      const marketCashboxes = await this.cashboxRepo.find({
        where: { cashbox_type: Cashbox_type.FOR_MARKET },
      });

      const noPagination = filters?.page === 0 || filters?.limit === 0;
      const page = noPagination
        ? 0
        : filters?.page && filters.page > 0
          ? filters.page
          : 1;
      const limit = noPagination
        ? 0
        : filters?.limit && filters.limit > 0
          ? filters.limit
          : 20;
      const qb = this.historyRepo
        .createQueryBuilder('h')
        .leftJoinAndSelect('h.cashbox', 'cashbox')
        .orderBy('h.createdAt', 'DESC');

      if (!noPagination) {
        qb.skip((page - 1) * limit).take(limit);
      }

      if (filters?.operationType)
        qb.andWhere('h.operation_type = :operationType', {
          operationType: filters.operationType,
        });
      if (filters?.sourceType)
        qb.andWhere('h.source_type = :sourceType', {
          sourceType: filters.sourceType,
        });
      if (filters?.createdBy)
        qb.andWhere('h.created_by = :createdBy', {
          createdBy: filters.createdBy,
        });
      if (filters?.cashboxType)
        qb.andWhere('cashbox.cashbox_type = :cashboxType', {
          cashboxType: filters.cashboxType,
        });
      if (filters?.fromDate)
        qb.andWhere('h.createdAt >= :fromDate', {
          fromDate: this.parseDate(filters.fromDate),
        });
      if (filters?.toDate)
        qb.andWhere('h.createdAt <= :toDate', {
          toDate: this.parseDate(filters.toDate),
        });

      const [allCashboxHistories, total] = await qb.getManyAndCount();
      const courierCashboxTotal = courierCashboxes.reduce(
        (s, c) => s + Number(c.balance),
        0,
      );
      const marketCashboxTotal = marketCashboxes.reduce(
        (s, c) => s + Number(c.balance),
        0,
      );

      return this.successRes(
        {
          mainCashboxTotal: Number(mainCashbox.balance),
          courierCashboxTotal,
          marketCashboxTotal,
          allCashboxHistories,
          pagination: {
            total,
            page,
            limit,
            totalPages: noPagination
              ? total > 0
                ? 1
                : 0
              : Math.ceil(total / limit),
          },
        },
        200,
        'All cashbox histories',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async financialBalance() {
    try {
      const mainCashbox = await this.ensureMainCashbox();
      const allCourierCashboxes = await this.cashboxRepo.find({
        where: { cashbox_type: Cashbox_type.FOR_COURIER },
      });
      const allMarketCashboxes = await this.cashboxRepo.find({
        where: { cashbox_type: Cashbox_type.FOR_MARKET },
      });

      const couriersTotalBalanse = allCourierCashboxes.reduce(
        (s, c) => s + Number(c.balance),
        0,
      );
      const marketsTotalBalans = allMarketCashboxes.reduce(
        (s, c) => s - Number(c.balance),
        0,
      );
      const difference = couriersTotalBalanse + marketsTotalBalans;
      const currentSituation = Number(mainCashbox.balance) + difference;

      return this.successRes(
        {
          currentSituation,
          main: mainCashbox,
          markets: { allMarketCashboxes, marketsTotalBalans },
          couriers: { allCourierCashboxes, couriersTotalBalanse },
          difference,
        },
        200,
        'Financial balance infos',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  // ===========================================================================
  // Operator earnings & payments
  // ===========================================================================

  /**
   * Record the commission an operator earned for a sold order. Triggered by
   * order-service via outbox when an order transitions into a sold state.
   *
   * Idempotent: keyed on order_id (UNIQUE). Re-delivery, or an order bouncing
   * SOLD↔PARTLY_PAID, updates the existing row instead of inserting a duplicate.
   * The commission rule is read from the operator's identity profile and
   * snapshotted onto the row so later config changes don't rewrite history.
   *
   * No commission config (or zero value) → no-op. The operator simply earns
   * nothing on this order; that is not an error.
   */
  async recordOperatorEarning(input: {
    order_id: string;
    operator_id?: string | null;
    market_id?: string | null;
    total_price?: number | null;
  }) {
    try {
      this.assertBigIntId(input.order_id, 'order_id');
      const operatorId = input.operator_id ? String(input.operator_id) : null;
      if (!operatorId || !/^\d+$/.test(operatorId)) {
        // Orders without an operator (e.g. admin-created) earn no commission.
        return this.successRes(null, 200, 'no operator — earning skipped');
      }

      const operator = await this.fetchOperatorCommission(operatorId);
      const totalPrice = Number(input.total_price ?? 0);
      const amount = this.computeCommission(
        operator?.commission_type ?? null,
        Number(operator?.commission_value ?? 0),
        totalPrice,
      );

      if (amount <= 0) {
        // Operator has no/zero commission for this order — nothing to record.
        // If a prior earning somehow exists (commission later zeroed), leave it;
        // recompute only happens on explicit re-sale with a real amount.
        return this.successRes(null, 200, 'zero commission — earning skipped');
      }

      const existing = await this.earningRepo.findOne({
        where: { order_id: String(input.order_id) },
      });

      if (existing) {
        const before = { amount: existing.amount };
        existing.amount = amount;
        existing.operator_id = operatorId;
        existing.market_id = input.market_id
          ? String(input.market_id)
          : existing.market_id;
        existing.commission_type = operator?.commission_type ?? null;
        existing.commission_value = Number(operator?.commission_value ?? 0);
        existing.order_total_price = totalPrice;
        const saved = await this.earningRepo.save(existing);
        await this.activityLog.logChange({
          entity_type: 'OperatorEarning',
          entity_id: saved.id,
          old_value: before,
          new_value: { amount: saved.amount },
          metadata: { order_id: input.order_id, operator_id: operatorId },
        });
        return this.successRes(saved, 200, 'operator earning updated');
      }

      const entity = this.earningRepo.create({
        operator_id: operatorId,
        order_id: String(input.order_id),
        market_id: input.market_id ? String(input.market_id) : null,
        amount,
        commission_type: operator?.commission_type ?? null,
        commission_value: Number(operator?.commission_value ?? 0),
        order_total_price: totalPrice,
      });
      const saved = await this.earningRepo.save(entity);
      await this.activityLog.log({
        entity_type: 'OperatorEarning',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          amount,
          operator_id: operatorId,
          order_id: input.order_id,
        },
        metadata: { commission_type: saved.commission_type },
      });
      return this.successRes(saved, 201, 'operator earning recorded');
    } catch (error) {
      // Unique violation = a concurrent delivery already inserted this order's
      // earning. That's the idempotency guarantee working — treat as success.
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        const existing = await this.earningRepo.findOne({
          where: { order_id: String(input.order_id) },
        });
        return this.successRes(
          existing,
          200,
          'operator earning already recorded',
        );
      }
      this.toRpcError(error);
    }
  }

  /**
   * Remove an operator earning when its order is rolled back out of a sold
   * state (e.g. WAITING again). Soft-deletes so the audit trail is preserved.
   */
  async removeOperatorEarning(input: { order_id: string }) {
    try {
      this.assertBigIntId(input.order_id, 'order_id');
      const existing = await this.earningRepo.findOne({
        where: { order_id: String(input.order_id) },
      });
      if (!existing) {
        return this.successRes(null, 200, 'no earning to remove');
      }
      // Soft delete via the BaseEntity flag (Elchi convention — entities use
      // `is_deleted` rather than a DeleteDateColumn). Balance queries below
      // already filter is_deleted=false, so this drops it from the total.
      existing.isDeleted = true;
      await this.earningRepo.save(existing);
      await this.activityLog.log({
        entity_type: 'OperatorEarning',
        entity_id: existing.id,
        action: ActivityAction.DELETED,
        old_value: { amount: existing.amount },
        metadata: { order_id: input.order_id, reason: 'order rolled back' },
      });
      return this.successRes(null, 200, 'operator earning removed');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /** Record a payout against an operator's accrued earnings. */
  async createOperatorPayment(input: {
    operator_id: string;
    market_id?: string | null;
    paid_by_id?: string | null;
    amount: number;
    note?: string | null;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const amount = Number(input.amount);
      this.assertPositiveAmount(amount, 'amount');

      const entity = this.paymentRepo.create({
        operator_id: String(input.operator_id),
        market_id: input.market_id ? String(input.market_id) : null,
        paid_by_id: input.paid_by_id ? String(input.paid_by_id) : null,
        amount,
        note: input.note ?? null,
      });
      const saved = await this.paymentRepo.save(entity);
      await this.activityLog.log({
        entity_type: 'OperatorPayment',
        entity_id: saved.id,
        action: ActivityAction.PAYMENT,
        new_value: { amount, operator_id: String(input.operator_id) },
        user_id: input.paid_by_id ? String(input.paid_by_id) : null,
        metadata: { note: input.note ?? null },
      });
      return this.successRes(saved, 201, 'operator payment recorded');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Operator balance = SUM(non-deleted earnings) - SUM(non-deleted payments).
   * Positive balance means we owe the operator.
   */
  async findOperatorBalance(input: { operator_id: string }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const operatorId = String(input.operator_id);

      const earnedRow = await this.earningRepo
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.amount), 0)', 'total')
        .where('e.operator_id = :operatorId', { operatorId })
        .andWhere('e.is_deleted = false')
        .getRawOne<{ total: string }>();

      const paidRow = await this.paymentRepo
        .createQueryBuilder('p')
        .select('COALESCE(SUM(p.amount), 0)', 'total')
        .where('p.operator_id = :operatorId', { operatorId })
        .andWhere('p.is_deleted = false')
        .getRawOne<{ total: string }>();

      const earned = Number(earnedRow?.total ?? 0);
      const paid = Number(paidRow?.total ?? 0);

      return this.successRes(
        {
          operator_id: operatorId,
          earned,
          paid,
          balance: earned - paid,
        },
        200,
        'operator balance',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async listOperatorEarnings(input: {
    operator_id: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);
      const [rows, total] = await this.earningRepo.findAndCount({
        where: { operator_id: String(input.operator_id), isDeleted: false },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
      return this.successRes(
        { rows, total, limit: take, offset: skip },
        200,
        'operator earnings',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async listOperatorPayments(input: {
    operator_id: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);
      const [rows, total] = await this.paymentRepo.findAndCount({
        where: { operator_id: String(input.operator_id), isDeleted: false },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
      return this.successRes(
        { rows, total, limit: take, offset: skip },
        200,
        'operator payments',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private computeCommission(
    type: string | null,
    value: number,
    totalPrice: number,
  ): number {
    if (!type || !Number.isFinite(value) || value <= 0) {
      return 0;
    }
    // `type` arrives as a raw string from identity; narrow to the enum for a
    // type-safe comparison.
    const commissionType = type as Commission_type;
    if (commissionType === Commission_type.PERCENT) {
      const price = Number.isFinite(totalPrice) ? Math.max(totalPrice, 0) : 0;
      return Math.max((price * value) / 100, 0);
    }
    if (commissionType === Commission_type.FIXED) {
      return Math.max(value, 0);
    }
    return 0;
  }

  private async fetchOperatorCommission(operatorId: string): Promise<{
    commission_type: string | null;
    commission_value: number;
  } | null> {
    try {
      const res = await rmqSend<{
        data?: {
          commission_type?: string | null;
          commission_value?: number | null;
        };
      }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_id' },
        { id: operatorId },
      );
      const user = res?.data;
      if (!user) {
        return null;
      }
      return {
        commission_type: user.commission_type ?? null,
        commission_value: Number(user.commission_value ?? 0),
      };
    } catch (err) {
      // If identity is unreachable we can't compute commission. Log and skip —
      // the earning event will be retried by the outbox publisher.
      this.logger.warn(
        `fetchOperatorCommission failed for operator ${operatorId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  // ===========================================================================
  // Financial balance ledger (company-wide P&L)
  // ===========================================================================

  // Advisory lock key — serialises ledger appends so balance_before/after of
  // concurrent writers can't interleave and corrupt the running total.
  private static readonly FBH_ADVISORY_LOCK_KEY = 947_310_021;

  /**
   * Append an entry to the financial-balance ledger. The running balance is
   * derived from the previous row, so writes MUST be serialised — a pg
   * advisory lock pins the critical section to one writer at a time.
   *
   * Idempotent for order-sourced entries: SELL_PROFIT/CORRECTION carry an
   * order_id, and a (source_type, order_id) pair is recorded at most once.
   * Re-delivery of the outbox event returns the existing row.
   */
  async recordFinancialBalance(input: {
    amount: number;
    source_type: FinancialSource_type;
    order_id?: string | null;
    related_user_id?: string | null;
    comment?: string | null;
    created_by?: string | null;
  }) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      // A zero-impact event has nothing to ledger.
      return this.successRes(null, 200, 'zero amount — ledger entry skipped');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        FinanceServiceService.FBH_ADVISORY_LOCK_KEY.toString(),
      ]);

      // Idempotency for order-linked sources.
      if (input.order_id) {
        const existing = await queryRunner.manager.findOne(
          FinancialBalanceHistory,
          {
            where: {
              order_id: String(input.order_id),
              source_type: input.source_type,
            },
          },
        );
        if (existing) {
          await queryRunner.commitTransaction();
          return this.successRes(
            existing,
            200,
            'ledger entry already recorded',
          );
        }
      }

      const last = await queryRunner.manager.findOne(FinancialBalanceHistory, {
        where: {},
        order: { id: 'DESC' },
      });
      const balanceBefore = Number(last?.balance_after ?? 0);
      const balanceAfter = balanceBefore + amount;

      const entity = queryRunner.manager.create(FinancialBalanceHistory, {
        amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        source_type: input.source_type,
        order_id: input.order_id ? String(input.order_id) : null,
        related_user_id: input.related_user_id
          ? String(input.related_user_id)
          : null,
        comment: input.comment ?? null,
        created_by: input.created_by ? String(input.created_by) : null,
      });
      const saved = await queryRunner.manager.save(entity);
      await queryRunner.commitTransaction();

      await this.activityLog.log({
        entity_type: 'FinancialBalanceHistory',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          amount,
          balance_after: balanceAfter,
          source_type: input.source_type,
        },
        user_id: input.created_by ? String(input.created_by) : null,
        metadata: { order_id: input.order_id ?? null },
      });

      return this.successRes(saved, 201, 'financial balance entry recorded');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async findFinancialBalanceHistory(input: {
    source_type?: FinancialSource_type;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);

      const where: FindOptionsWhere<FinancialBalanceHistory> = {
        isDeleted: false,
      };
      if (input.source_type) {
        where.source_type = input.source_type;
      }
      const from = this.parseDate(input.from_date);
      const to = this.parseDate(input.to_date);
      if (from && to) {
        where.createdAt = Between(from, to);
      } else if (from) {
        where.createdAt = MoreThanOrEqual(from);
      } else if (to) {
        where.createdAt = LessThanOrEqual(to);
      }

      const [rows, total] = await this.financialHistoryRepo.findAndCount({
        where,
        order: { createdAt: 'DESC', id: 'DESC' },
        take,
        skip,
      });

      const latest = await this.financialHistoryRepo.findOne({
        where: { isDeleted: false },
        order: { id: 'DESC' },
      });
      const currentBalance = Number(latest?.balance_after ?? 0);

      return this.successRes(
        { rows, total, currentBalance, limit: take, offset: skip },
        200,
        'financial balance history',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
