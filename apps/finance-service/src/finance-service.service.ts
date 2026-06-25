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
  ActivityLogQuery,
  ActivityLogService,
  Cashbox_type,
  Commission_type,
  FinancialSource_type,
  Operation_type,
  Order_status,
  PaymentMethod,
  Source_type,
  rmqSend,
  OutboxService,
} from '@app/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
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
    private readonly outbox: OutboxService,
  ) {}

  async onModuleInit() {
    const main = await this.cashboxRepo.findOne({
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: false,
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

  private auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
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
        isDeleted: false,
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
        where: { id: selector.cashbox_id, isDeleted: false },
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
        isDeleted: false,
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
        where: { id: selector.cashbox_id, isDeleted: false },
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
        isDeleted: false,
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
    // System-generated sale/settlement legs (via the outbox `update_balance`
    // path) may drive a BRANCH cashbox negative — a sub-share sale legitimately
    // leaves the branch owing negative (HQ tops up). Without this the branch
    // EXPENSE leg threw, the outbox retried 10x and silently dropped, so HQ's
    // view of branch debt was understated. Manual remittances keep the strict
    // check (override stays false). (Audit I13.)
    allowNegativeOverride = false,
  ) {
    const sign = operation === Operation_type.INCOME ? 1 : -1;
    const allowNegativeBalance =
      cashbox.cashbox_type === Cashbox_type.FOR_MARKET ||
      cashbox.cashbox_type === Cashbox_type.FOR_COURIER ||
      allowNegativeOverride;

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
          isDeleted: false,
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
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          cashbox_type: saved.cashbox_type,
          balance: saved.balance,
        },
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id, cashbox_type: saved.cashbox_type },
      });
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
            isDeleted: false,
          },
        });

        if (!cashbox) {
          throw new NotFoundException('Cashbox not found');
        }

        if (!dto.with_history) {
          return this.successRes(cashbox, 200, 'Cashbox found');
        }

        const historyWhere: FindOptionsWhere<CashboxHistory> = {
          cashbox_id: cashbox.id,
          isDeleted: false,
        };
        if (dto.history_source_type) {
          historyWhere.source_type = dto.history_source_type;
        }

        const [history, total] = await this.historyRepo.findAndCount({
          where: historyWhere,
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
        where: { user_id: dto.user_id, isDeleted: false },
        order: { createdAt: 'DESC' },
      });

      if (!dto.with_history) {
        return this.successRes(all, 200, 'Cashboxes found');
      }

      const historyQuery = this.historyRepo
        .createQueryBuilder('history')
        .innerJoinAndSelect('history.cashbox', 'cashbox')
        .where('cashbox.user_id = :userId', { userId: dto.user_id })
        .andWhere('cashbox.isDeleted = :cashboxActive', {
          cashboxActive: false,
        })
        .andWhere('history.isDeleted = :historyActive', {
          historyActive: false,
        })
        .orderBy('history.createdAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);

      if (dto.history_source_type) {
        historyQuery.andWhere('history.source_type = :historySourceType', {
          historySourceType: dto.history_source_type,
        });
      }

      const [history, total] = await historyQuery.getManyAndCount();

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
    // Captured after a successful (non-idempotent) commit so we can write the
    // audit row only once the transaction is durable and the runner released.
    // Declared at method scope so the outer `finally` (a sibling of the inner
    // try) can read it.
    let auditedCashbox: Cashbox | null = null;
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
          // System sale/settlement leg: a BRANCH cashbox may go negative here
          // (sub-share sale; HQ tops up) so the leg is never poison-dropped.
          cashbox.cashbox_type === Cashbox_type.BRANCH,
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
        auditedCashbox = savedCashbox;

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
    } finally {
      if (auditedCashbox) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedCashbox.id,
          action: 'finance.balance_update',
          new_value: {
            balance: auditedCashbox.balance,
            operation_type: dto.operation_type,
            amount: Number(dto.amount),
          },
          user_id: dto.created_by ? String(dto.created_by) : null,
          metadata: {
            user_id: dto.user_id ?? null,
            source_id: dto.source_id ?? null,
            source_user_id: dto.source_user_id ?? null,
            amount: Number(dto.amount),
            created_by: dto.created_by ?? null,
            direction: dto.operation_type,
          },
        });
      }
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

      const where: FindOptionsWhere<CashboxHistory> = { isDeleted: false };

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
      if (dto.source_user_id) {
        this.assertBigIntId(dto.source_user_id, 'source_user_id');
        where.source_user_id = dto.source_user_id;
      }
      if (dto.created_by) {
        this.assertBigIntId(dto.created_by, 'created_by');
        where.created_by = dto.created_by;
      }
      if (historyCashboxType) {
        const cashboxesByType = await this.cashboxRepo.find({
          where: {
            cashbox_type: historyCashboxType,
            isDeleted: false,
          },
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
            isDeleted: false,
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
        where: { id, isDeleted: false },
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
        await this.activityLog.log({
          entity_type: 'Shift',
          entity_id: saved.id,
          action: ActivityAction.CREATED,
          new_value: {
            opened_by: saved.opened_by,
            opened_at: saved.opened_at,
          },
          user_id: dto.opened_by ? String(dto.opened_by) : null,
          metadata: { opened_by: dto.opened_by },
        });
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

      // Captured after a durable commit so the audit row is written once the
      // transaction is committed and the runner released (never inside the tx).
      let auditedShift: Shift | null = null;

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
        auditedShift = saved;
        return this.successRes(saved, 200, 'Shift closed');
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
        if (auditedShift) {
          await this.activityLog.log({
            entity_type: 'Shift',
            entity_id: auditedShift.id,
            action: ActivityAction.STATUS_CHANGE,
            new_value: {
              status: auditedShift.status,
              closed_at: auditedShift.closed_at,
            },
            user_id: dto.closed_by ? String(dto.closed_by) : null,
            metadata: {
              closed_by: dto.closed_by,
              opened_by: auditedShift.opened_by,
            },
          });
        }
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
      await this.activityLog.log({
        entity_type: 'UserSalary',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          salary_amount: saved.salary_amount,
          payment_day: saved.payment_day,
        },
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id },
      });
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

      // Snapshot BEFORE mutating so logChange can diff only the changed fields.
      const before = {
        salary_amount: Number(salary.salary_amount),
        have_to_pay: Number(salary.have_to_pay),
        payment_day: Number(salary.payment_day),
      };

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
      await this.activityLog.logChange({
        entity_type: 'UserSalary',
        entity_id: saved.id,
        old_value: before,
        new_value: {
          salary_amount: Number(saved.salary_amount),
          have_to_pay: Number(saved.have_to_pay),
          payment_day: Number(saved.payment_day),
        },
        action: ActivityAction.UPDATED,
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id },
      });
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
        isDeleted: false,
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
    history_source_type?: Source_type;
  }) {
    try {
      this.assertBigIntId(data.id, 'id');
      const where: FindOptionsWhere<Cashbox> = {
        user_id: data.id,
        isDeleted: false,
      };
      if (data.cashbox_type) where.cashbox_type = data.cashbox_type;

      const cashbox = await this.cashboxRepo.findOne({
        where,
        order: { createdAt: 'DESC' },
      });
      if (!cashbox) throw new NotFoundException('Cashbox not found');

      const { start, end } = this.parseDateRange(data.fromDate, data.toDate);
      const historyWhere: FindOptionsWhere<CashboxHistory> = {
        cashbox_id: cashbox.id,
        isDeleted: false,
      };
      if (data.history_source_type) {
        historyWhere.source_type = data.history_source_type;
      }
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
    cashbox_type?: Cashbox_type;
    fromDate?: string;
    toDate?: string;
  }) {
    try {
      this.assertBigIntId(data.user_id, 'user_id');
      const roles = (data.roles ?? []).map((r) => r.toLowerCase());
      const isManager =
        roles.includes('manager') &&
        !roles.includes('superadmin') &&
        !roles.includes('admin');
      const cashboxType =
        data.cashbox_type ??
        (roles.includes('market')
          ? Cashbox_type.FOR_MARKET
          : isManager
            ? Cashbox_type.BRANCH
            : Cashbox_type.FOR_COURIER);
      const targetUserId =
        cashboxType === Cashbox_type.BRANCH
          ? String(data.branch_id ?? '').trim()
          : data.user_id;
      const historySourceType =
        cashboxType === Cashbox_type.FOR_MARKET
          ? Source_type.MARKET_PAYMENT
          : cashboxType === Cashbox_type.BRANCH
            ? Source_type.BRANCH_TO_MAIN
            : Source_type.COURIER_PAYMENT;

      if (cashboxType === Cashbox_type.BRANCH && !targetUserId) {
        throw new BadRequestException('Manager uchun branch_id majburiy');
      }
      let cashbox = await this.cashboxRepo.findOne({
        where: {
          user_id: targetUserId,
          cashbox_type: cashboxType,
          isDeleted: false,
        },
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
        history_source_type: historySourceType,
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
    created_by?: string;
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
        created_by: data.created_by ?? data.user_id,
        cashbox_type: targetCashboxType,
      });
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: String(update?.data?.cashbox?.id ?? targetUserId),
        action: 'finance.manual_expense',
        new_value: { amount: Number(data.amount), payment_method: data.type },
        user_id: data.user_id ? String(data.user_id) : null,
        metadata: {
          user_id: data.user_id,
          amount: Number(data.amount),
          cashbox_type: targetCashboxType,
        },
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
    created_by?: string;
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
        created_by: data.created_by ?? data.user_id,
        cashbox_type: targetCashboxType,
      });
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: String(update?.data?.cashbox?.id ?? targetUserId),
        action: 'finance.manual_income',
        new_value: { amount: Number(data.amount), payment_method: data.type },
        user_id: data.user_id ? String(data.user_id) : null,
        metadata: {
          user_id: data.user_id,
          amount: Number(data.amount),
          cashbox_type: targetCashboxType,
        },
      });
      return this.successRes(update?.data ?? {}, 200, 'Cashbox filled');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Idempotency pre-check for a manual lump-sum transfer (courier/branch/market
   * payment). Returns true when this exact payment — keyed by the gateway's
   * per-request `dedup_epoch` token on the source-cashbox leg — has already been
   * applied (duplicate RMQ delivery or operator double-submit). The caller must
   * already hold the source cashbox row lock so it sees committed prior rows.
   * (Audit P0-3.) When no token is supplied the transfer is not deduped
   * (backward-compatible with callers that don't send one).
   */
  private async isDuplicateTransfer(
    manager: EntityManager,
    params: {
      cashbox_id: string;
      source_type: Source_type;
      source_id: string;
      operation_type: Operation_type;
      dedup_epoch: string;
    },
  ): Promise<boolean> {
    if (!params.dedup_epoch) {
      return false;
    }
    const existing = await manager.findOne(CashboxHistory, {
      where: {
        cashbox_id: String(params.cashbox_id),
        source_type: params.source_type,
        source_id: String(params.source_id),
        operation_type: params.operation_type,
        dedup_epoch: params.dedup_epoch,
      },
    });
    return !!existing;
  }

  /**
   * Enqueue the per-order FIFO settlement advance for a committed cash handover,
   * INSIDE the caller's cashbox transaction (Faza 2a). The transactional outbox
   * gives at-least-once, retried, DLQ-backed delivery to order-service, so the
   * order_settlement ledger always catches up with the cashbox movement —
   * replacing the old best-effort gateway call that silently swallowed any
   * failure (re-opening the cashbox↔settlement split-brain and blinding the
   * rollback guard). Idempotent: the shared per-payment `token` becomes the
   * request_id, so a redelivered outbox event is deduped by order-service's
   * runIdempotent and order_settlement is never advanced twice. (Audit I1/I2.)
   */
  private async enqueueSettlementAdvance(
    manager: EntityManager,
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market',
    matchValue: string,
    amount: number,
    requesterId: string | null | undefined,
    token: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      level,
      match_value: String(matchValue ?? ''),
      amount: Number(amount ?? 0),
      requester_id: requesterId ? String(requesterId) : undefined,
    };
    // Bake the shared idempotency key into the payload so the in-tx outbox row
    // AND the post-commit immediate publish (Faza 2c) carry the SAME request_id
    // and order-service dedupes them — the advance runs exactly once.
    if (token) {
      payload.request_id = token;
    }
    await this.outbox.enqueue('ORDER', 'order.settlement.advance', payload, {
      manager,
      requestId: token || undefined,
    });
    return payload;
  }

  /**
   * Best-effort IMMEDIATE publish of the settlement advance, right after the
   * cashbox transaction commits (Faza 2c). Closes the ~1s outbox-poll lag window
   * during which order_settlement would otherwise be stale and the rollback
   * guard inaccurate (cash already moved up-chain, status not yet advanced). It
   * is purely a latency optimization: the outbox row enqueued in the committed
   * transaction is the durability guarantee, so a failure here is swallowed and
   * the relay delivers the same (idempotent, same request_id) event. Only fires
   * when an idempotency key is present, so the immediate send and the relay can
   * never double-advance.
   */
  private async tryPublishAdvanceNow(
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!payload?.request_id) {
      return;
    }
    try {
      await firstValueFrom(
        this.orderClient
          .send({ cmd: 'order.settlement.advance' }, payload)
          .pipe(timeout(2000)),
      );
    } catch {
      // Swallowed — the transactional outbox relay guarantees eventual delivery.
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
    // Per-request idempotency token from the gateway; dedupes RMQ redelivery /
    // double-submit so the cash is never moved twice. (Audit P0-3.)
    dedup_epoch?: string;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedCourierCashboxId: string | null = null;
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
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!courierCashbox)
        throw new NotFoundException('Courier cashbox not found');

      // Idempotency: under the courier-cashbox lock, bail out if this exact
      // payment was already applied (duplicate delivery / double-submit).
      const dedupKey = String(data.dedup_epoch ?? '').trim();
      const paymentSourceId = dedupKey ? String(data.courier_id) : null;
      if (
        await this.isDuplicateTransfer(queryRunner.manager, {
          cashbox_id: String(courierCashbox.id),
          source_type: Source_type.COURIER_PAYMENT,
          source_id: String(data.courier_id),
          operation_type: Operation_type.EXPENSE,
          dedup_epoch: dedupKey,
        })
      ) {
        await queryRunner.commitTransaction();
        return this.successRes(
          { idempotent: true },
          200,
          "To'lov allaqachon qabul qilingan (takroriy so'rov)",
        );
      }

      // Over-remit guard (Faza 1c / Audit I1): a courier cannot remit more cash
      // than their cashbox holds. FOR_COURIER allows a negative balance (so
      // sale-time COD legs work), which means a duplicate-key-evading double
      // submit, or a wrong amount, would otherwise silently drive the courier
      // cashbox negative — cash that never physically existed. We check AFTER the
      // idempotency short-circuit so a genuine retry still returns idempotent.
      if (Number(data.amount) > Number(courierCashbox.balance)) {
        throw new BadRequestException(
          `To'lov miqdori courier qoldig'idan oshib ketdi (qoldiq: ${Number(
            courierCashbox.balance,
          )})`,
        );
      }

      const receiverUserId = String(
        data.receiver_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
      );
      const receiverCashboxType =
        data.receiver_cashbox_type ?? Cashbox_type.MAIN;

      let receiverCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: receiverUserId,
          cashbox_type: receiverCashboxType,
          isDeleted: false,
        },
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
        source_id: paymentSourceId,
        dedup_epoch: dedupKey,
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

      // Advance the per-order FIFO settlement ledger (courier → branch) in the
      // SAME transaction as the cashbox move (Faza 2a). Reliable outbox delivery
      // to order-service replaces the old best-effort gateway bridge.
      const advancePayload = await this.enqueueSettlementAdvance(
        queryRunner.manager,
        'courier_to_branch',
        String(data.courier_id),
        Number(data.amount),
        data.created_by,
        dedupKey,
      );

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      await this.tryPublishAdvanceNow(advancePayload);
      auditedCourierCashboxId = String(courierCashbox.id);

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
      if (auditedCourierCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedCourierCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            courier_id: data.courier_id,
            market_id: data.market_id ?? null,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
            receiver_user_id:
              data.receiver_user_id ??
              FinanceServiceService.MAIN_CASHBOX_USER_ID,
          },
        });
      }
    }
  }

  async paymentFromBranchToMain(data: {
    branch_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    created_by?: string;
    // Per-request idempotency token from the gateway. (Audit P0-3.)
    dedup_epoch?: string;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedBranchCashboxId: string | null = null;
    try {
      this.assertBigIntId(data.branch_id, 'branch_id');
      this.assertPositiveAmount(Number(data.amount));

      const branchCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: { user_id: data.branch_id, cashbox_type: Cashbox_type.BRANCH },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branchCashbox)
        throw new NotFoundException('Branch cashbox not found');

      // Idempotency: under the branch-cashbox lock, bail out if already applied.
      const dedupKey = String(data.dedup_epoch ?? '').trim();
      const paymentSourceId = dedupKey ? String(data.branch_id) : null;
      if (
        await this.isDuplicateTransfer(queryRunner.manager, {
          cashbox_id: String(branchCashbox.id),
          source_type: Source_type.BRANCH_TO_MAIN,
          source_id: String(data.branch_id),
          operation_type: Operation_type.EXPENSE,
          dedup_epoch: dedupKey,
        })
      ) {
        await queryRunner.commitTransaction();
        return this.successRes(
          { idempotent: true },
          200,
          "To'lov allaqachon qabul qilingan (takroriy so'rov)",
        );
      }

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
        source_id: paymentSourceId,
        dedup_epoch: dedupKey,
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

      // Advance the per-order FIFO settlement ledger (branch → HQ) in the SAME
      // transaction as the cashbox move (Faza 2a). Reliable outbox delivery to
      // order-service replaces the old best-effort gateway bridge.
      const advancePayload = await this.enqueueSettlementAdvance(
        queryRunner.manager,
        'branch_to_hq',
        String(data.branch_id),
        Number(data.amount),
        data.created_by,
        dedupKey,
      );

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      await this.tryPublishAdvanceNow(advancePayload);
      auditedBranchCashboxId = String(branchCashbox.id);
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
      if (auditedBranchCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedBranchCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            branch_id: data.branch_id,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
          },
        });
      }
    }
  }

  async paymentsToMarket(data: {
    market_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    created_by?: string;
    // Per-request idempotency token from the gateway. (Audit P0-3.)
    dedup_epoch?: string;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedMarketCashboxId: string | null = null;
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

      // Idempotency: under the main+market cashbox locks, bail out if already
      // applied (duplicate delivery / double-submit). (Audit P0-3.)
      const dedupKey = String(data.dedup_epoch ?? '').trim();
      const paymentSourceId = dedupKey ? String(data.market_id) : null;
      if (
        await this.isDuplicateTransfer(queryRunner.manager, {
          cashbox_id: String(mainCashbox.id),
          source_type: Source_type.MARKET_PAYMENT,
          source_id: String(data.market_id),
          operation_type: Operation_type.EXPENSE,
          dedup_epoch: dedupKey,
        })
      ) {
        await queryRunner.commitTransaction();
        return this.successRes(
          { idempotent: true },
          200,
          "To'lov allaqachon bajarilgan (takroriy so'rov)",
        );
      }

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
          source_id: paymentSourceId,
          dedup_epoch: dedupKey,
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

      // Advance the per-order FIFO settlement ledger (HQ → market) in the SAME
      // transaction as the cashbox move (Faza 2a). Reliable outbox delivery to
      // order-service replaces the old best-effort gateway bridge.
      const advancePayload = await this.enqueueSettlementAdvance(
        queryRunner.manager,
        'hq_to_market',
        String(data.market_id),
        Number(data.amount),
        data.created_by,
        dedupKey,
      );

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      await this.tryPublishAdvanceNow(advancePayload);
      auditedMarketCashboxId = String(marketCashbox.id);
      await this.syncMarketPaymentsSafely(data.market_id, Number(data.amount));

      return this.successRes({}, 200, `Marketga ${data.amount} so'm to'landi`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
      if (auditedMarketCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedMarketCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            market_id: data.market_id,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
          },
        });
      }
    }
  }

  async allCashboxesTotal(filters?: {
    operationType?: Operation_type;
    operation_type?: Operation_type;
    sourceType?: Source_type;
    source_type?: Source_type;
    createdBy?: string;
    created_by?: string;
    cashboxType?: Cashbox_type;
    cashbox_type?: Cashbox_type;
    fromDate?: string;
    from_date?: string;
    toDate?: string;
    to_date?: string;
    page?: number;
    limit?: number;
  }) {
    try {
      const mainCashbox = await this.ensureMainCashbox();
      const courierCashboxes = await this.cashboxRepo.find({
        where: {
          cashbox_type: Cashbox_type.FOR_COURIER,
          isDeleted: false,
        },
      });
      const marketCashboxes = await this.cashboxRepo.find({
        where: {
          cashbox_type: Cashbox_type.FOR_MARKET,
          isDeleted: false,
        },
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
        .where('h.isDeleted = :historyActive', { historyActive: false })
        .andWhere('cashbox.isDeleted = :cashboxActive', {
          cashboxActive: false,
        })
        .orderBy('h.createdAt', 'DESC');

      if (!noPagination) {
        qb.skip((page - 1) * limit).take(limit);
      }

      const operationType = filters?.operationType ?? filters?.operation_type;
      const sourceType = filters?.sourceType ?? filters?.source_type;
      const createdBy = filters?.createdBy ?? filters?.created_by;
      const cashboxType = filters?.cashboxType ?? filters?.cashbox_type;
      const fromDate = filters?.fromDate ?? filters?.from_date;
      const toDate = filters?.toDate ?? filters?.to_date;

      if (operationType)
        qb.andWhere('h.operation_type = :operationType', {
          operationType,
        });
      if (sourceType)
        qb.andWhere('h.source_type = :sourceType', {
          sourceType,
        });
      if (createdBy)
        qb.andWhere('h.created_by = :createdBy', {
          createdBy,
        });
      if (cashboxType)
        qb.andWhere('cashbox.cashbox_type = :cashboxType', {
          cashboxType,
        });
      if (fromDate)
        qb.andWhere('h.createdAt >= :fromDate', {
          fromDate: this.parseDate(fromDate),
        });
      if (toDate)
        qb.andWhere('h.createdAt <= :toDate', {
          toDate: this.parseDate(toDate),
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
      const allMarketCashboxes = await this.cashboxRepo.find({
        where: {
          cashbox_type: Cashbox_type.FOR_MARKET,
          isDeleted: false,
        },
      });
      const settlementResponse = await rmqSend<{
        data?: {
          branch_receivable?: number;
          market_payable?: number;
          branches?: Array<{ branch_id: string; amount: number }>;
          markets?: Array<{ market_id: string; amount: number }>;
        };
      }>(
        this.orderClient,
        { cmd: 'order.settlement.financial_balance_summary' },
        {},
      );
      const settlement = settlementResponse?.data ?? {};
      const branchReceivable = Math.max(
        Number(settlement.branch_receivable ?? 0),
        0,
      );
      const marketPayable = Math.max(Number(settlement.market_payable ?? 0), 0);
      const difference = branchReceivable - marketPayable;
      const currentSituation = Number(mainCashbox.balance) + difference;

      return this.successRes(
        {
          currentSituation,
          main: mainCashbox,
          branches: {
            branchReceivable,
            items: settlement.branches ?? [],
          },
          markets: {
            allMarketCashboxes,
            marketPayable,
            marketsTotalBalans: -marketPayable,
            items: settlement.markets ?? [],
          },
          couriers: {
            allCourierCashboxes: [],
            couriersTotalBalanse: 0,
          },
          difference,
          formula: 'main_cashbox + branch_receivable - market_payable',
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
