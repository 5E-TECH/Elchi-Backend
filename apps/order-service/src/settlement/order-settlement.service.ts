import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { Cashbox_type, SettlementStatus, rmqSend } from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';

/**
 * Per-order COD settlement: the transaction-OWNING advance path + read surface,
 * extracted from the OrderServiceService god object (Audit decomposition).
 *
 * IMPORTANT boundary: the settlement WRITE helpers that participate in the
 * LIFECYCLE's transaction (recordSaleSettlement / resetSettlementOnRollback /
 * resolveSettlementBranchId / resolveBranchShare, plus the isSettledToHq guard)
 * deliberately STAY in OrderServiceService — they are called inside sellOrder /
 * partlySellOrder / rollback with the caller's own EntityManager, so moving them
 * would break money-mutation atomicity. This service owns only the paths that
 * open their OWN queryRunner (runFifoSettlement via advanceSettlement) or are
 * read-only (getSettlementByOrderId / financial-balance summary), plus the
 * retired settle* stubs. badRequest/handleDbError are duplicated leaf helpers.
 */
@Injectable()
export class OrderSettlementService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(OrderSettlement)
    private readonly orderSettlementRepo: Repository<OrderSettlement>,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
  ) {}

  // ===== leaf helpers duplicated from OrderServiceService =====

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  private handleDbError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as {
        code?: string;
        message?: string;
        column?: string;
        table?: string;
      };
      const rawMessage = pgError?.message ?? '';

      if (rawMessage.includes('orders_status_enum')) {
        throw new RpcException({
          statusCode: 400,
          message: "status noto'g'ri qiymat",
        });
      }
      if (rawMessage.includes('orders_where_deliver_enum')) {
        throw new RpcException({
          statusCode: 400,
          message: "where_deliver noto'g'ri qiymat",
        });
      }
      if (pgError?.code === '22P02') {
        if (rawMessage.includes('bigint')) {
          throw new RpcException({
            statusCode: 400,
            message: "ID qiymatlari raqam ko'rinishida bo'lishi kerak",
          });
        }
        throw new RpcException({
          statusCode: 400,
          message: "Noto'g'ri formatdagi qiymat yuborildi",
        });
      }
      if (pgError?.code === '23502') {
        const column = pgError?.column ?? 'unknown';
        const table = pgError?.table ?? 'unknown';
        throw new RpcException({
          statusCode: 400,
          message: `Majburiy maydon bo'sh yuborildi: ${table}.${column}`,
        });
      }
      if (pgError?.code === '23503') {
        throw new RpcException({
          statusCode: 400,
          message: "Bog'langan ma'lumot topilmadi",
        });
      }
    }
    throw error;
  }

  // ===== settlement advance + read surface (moved verbatim) =====
  /**
   * Path A retired (Faza 2b). The legacy `order.settlement.{courier_to_branch,
   * branch_to_hq,hq_to_market}` handlers used to MOVE cashbox money themselves
   * (posting legs keyed by source_id = order_id, no dedup_epoch). That
   * duplicated the production `finance.cashbox.payment_*` path (which posts legs
   * keyed by source_id = actor_id + a dedup token) — different keys, so finance's
   * idempotency index could NOT collapse them and one physical handover posted
   * twice (double-debit). Cash now moves ONLY through the finance payment
   * endpoints, which advance the per-order settlement ledger via the
   * transactional outbox (Faza 2a). These endpoints are disabled so the two
   * money-movers can never both run for the same handover.
   */
  private deprecatedSettlementPath(level: string): never {
    this.badRequest(
      `order.settlement.${level} endi qo'llab-quvvatlanmaydi (Faza 2b): ` +
        `pul faqat cashbox to'lov endpointlari orqali ko'chiriladi, ular ` +
        `settlement'ni outbox orqali avtomatik advance qiladi.`,
    );
  }

  /** Return the per-order settlement row (status + leg stamps) for one order. */
  async getSettlementByOrderId(orderId: string) {
    const id = String(orderId ?? '').trim();
    if (!id) {
      this.badRequest('order id is required');
    }
    const settlement = await this.orderSettlementRepo.findOne({
      where: { order_id: id },
    });
    return successRes(settlement ?? null, 200, 'Order settlement');
  }

  async getFinancialBalanceSettlementSummary() {
    const activeStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ];
    const branchReceivableStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
    ];

    const [branchRows, marketRows] = await Promise.all([
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.branch_id', 'branch_id')
        .addSelect('COALESCE(SUM(settlement.branch_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.branch_id IS NOT NULL')
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: branchReceivableStatuses,
        })
        .groupBy('settlement.branch_id')
        .getRawMany<{ branch_id: string; amount: string }>(),
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.market_id', 'market_id')
        .addSelect('COALESCE(SUM(settlement.market_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.market_id IS NOT NULL')
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: activeStatuses,
        })
        .groupBy('settlement.market_id')
        .getRawMany<{ market_id: string; amount: string }>(),
    ]);

    const branches = branchRows.map((row) => ({
      branch_id: String(row.branch_id),
      amount: Math.max(Number(row.amount) || 0, 0),
    }));
    const markets = marketRows.map((row) => ({
      market_id: String(row.market_id),
      amount: Math.max(Number(row.amount) || 0, 0),
    }));

    return successRes(
      {
        branch_receivable: branches.reduce((sum, row) => sum + row.amount, 0),
        market_payable: markets.reduce((sum, row) => sum + row.amount, 0),
        branches,
        markets,
      },
      200,
      'Financial balance settlement summary',
    );
  }

  private static readonly MAIN_CASHBOX_USER_ID = '0';

  /** Ensure the singleton MAIN (HQ) cashbox exists before posting to it. */
  private async ensureMainCashbox(): Promise<void> {
    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.create' },
      {
        user_id: OrderSettlementService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
    ).catch(() => undefined);
  }

  /**
   * FIFO-allocate a lump-sum settlement payment to the oldest unsettled orders
   * for one participant, advancing each fully-covered order to the next leg and
   * posting its cashbox movements (atomic with the status update via outbox).
   * Whole-order allocation: an order is only settled when the remaining lump-sum
   * covers its full leg amount; the unallocated remainder is reported back.
   */
  private async runFifoSettlement(params: {
    matchColumn: 'courier_id' | 'branch_id' | 'market_id';
    matchValue: string;
    fromStatus: SettlementStatus;
    toStatus: SettlementStatus;
    amountField: 'courier_amount' | 'branch_amount' | 'market_amount';
    lumpSum: number;
    requesterId: string;
    postLeg: (
      manager: EntityManager,
      settlement: OrderSettlement,
      amount: number,
    ) => Promise<void>;
    stamp: (now: Date) => Partial<OrderSettlement>;
  }): Promise<{
    settled_order_ids: string[];
    allocated: number;
    leftover: number;
  }> {
    const lumpSum = Math.max(Number(params.lumpSum) || 0, 0);
    if (!params.matchValue || lumpSum <= 0) {
      return { settled_order_ids: [], allocated: 0, leftover: lumpSum };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const settledOrderIds: string[] = [];
    let allocated = 0;
    try {
      const tx = queryRunner.manager;
      const repo = tx.getRepository(OrderSettlement);
      const candidates = await repo.find({
        where: {
          [params.matchColumn]: params.matchValue,
          status: params.fromStatus,
          isDeleted: false,
        } as Record<string, unknown>,
        order: { createdAt: 'ASC' },
      });

      let remaining = lumpSum;
      const now = new Date();
      for (const settlement of candidates) {
        const legAmount = Math.max(
          Number(settlement[params.amountField] ?? 0),
          0,
        );
        // Strict FIFO (Faza 4 / Audit I16): if the OLDEST still-unsettled order's
        // leg does not fully fit in the remaining lump-sum, STOP — never skip
        // ahead to settle a newer, smaller order before an older one. Skipping
        // violates oldest-first accounting and lets a deliberate resubmit
        // over-allocate to the next orders. Zero-amount legs (nothing owed at
        // this hop) still advance for free without consuming the lump-sum.
        if (legAmount > remaining && legAmount > 0) {
          break;
        }
        await repo.update(
          { id: settlement.id },
          { status: params.toStatus, ...params.stamp(now) },
        );
        if (legAmount > 0) {
          await params.postLeg(tx, settlement, legAmount);
          remaining -= legAmount;
          allocated += legAmount;
        }
        settledOrderIds.push(String(settlement.order_id));
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    return {
      settled_order_ids: settledOrderIds,
      allocated,
      leftover: Math.max(lumpSum - allocated, 0),
    };
  }

  /**
   * Advance the per-order FIFO settlement ledger WITHOUT posting any cashbox leg.
   * The production cash path (finance.cashbox.payment_courier/branch_to_main/
   * market) already moves the cashbox balances; this keeps order_settlement in
   * lock-step so that (a) the settlement-aware rollback guard (isSettledToHq)
   * actually reflects real-world cash position in production, and (b) the legacy
   * order.settlement.* cashbox path becomes a no-op for already-advanced rows
   * (its candidates are filtered by fromStatus), so the two paths can never
   * double-post the same handover. (Audit I1/I2.)
   */
  async advanceSettlement(data: {
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
    match_value: string;
    amount: number;
    requester_id?: string;
  }) {
    const requesterId = String(data?.requester_id ?? 'system');
    const matchValue = String(data?.match_value ?? '').trim();
    const amount = Number(data?.amount ?? 0);
    if (!matchValue || !(amount > 0)) {
      return successRes(
        { settled_order_ids: [], allocated: 0, leftover: amount },
        200,
        'No settlement to advance',
      );
    }

    // State-only: the cashbox was already moved by the finance payment path.
    const noPost = async (): Promise<void> => {};

    const configs = {
      courier_to_branch: {
        matchColumn: 'courier_id' as const,
        fromStatus: SettlementStatus.PENDING,
        toStatus: SettlementStatus.COURIER_SETTLED,
        amountField: 'courier_amount' as const,
        stamp: (now: Date) => ({
          courier_to_branch_at: now,
          courier_to_branch_by: requesterId,
        }),
      },
      branch_to_hq: {
        matchColumn: 'branch_id' as const,
        fromStatus: SettlementStatus.COURIER_SETTLED,
        toStatus: SettlementStatus.BRANCH_SETTLED,
        amountField: 'branch_amount' as const,
        stamp: (now: Date) => ({
          branch_to_hq_at: now,
          branch_to_hq_by: requesterId,
        }),
      },
      hq_to_market: {
        matchColumn: 'market_id' as const,
        fromStatus: SettlementStatus.BRANCH_SETTLED,
        toStatus: SettlementStatus.MARKET_SETTLED,
        amountField: 'market_amount' as const,
        stamp: (now: Date) => ({
          hq_to_market_at: now,
          hq_to_market_by: requesterId,
        }),
      },
    };
    const cfg = configs[data.level];
    if (!cfg) {
      this.badRequest(`Invalid settlement level: ${String(data?.level)}`);
    }

    const result = await this.runFifoSettlement({
      matchColumn: cfg.matchColumn,
      matchValue,
      fromStatus: cfg.fromStatus,
      toStatus: cfg.toStatus,
      amountField: cfg.amountField,
      lumpSum: amount,
      requesterId,
      postLeg: noPost,
      stamp: cfg.stamp,
    });
    return successRes(result, 200, 'Settlement advanced');
  }

  /**
   * Courier hands a lump sum to the branch — FIFO-settles the courier's oldest
   * PENDING orders (courier → branch). Only reduces the courier's owed balance;
   * the branch was already credited at sale time.
   */
  async settleCourierToBranch(
    _requester: { id: string; roles?: string[] },
    _dto: { courier_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('courier_to_branch');
  }

  /**
   * Branch remits a lump sum to HQ — FIFO-settles the branch's oldest
   * COURIER_SETTLED orders (branch → HQ): branch owed-balance down, MAIN up.
   */
  async settleBranchToHq(
    _requester: { id: string; roles?: string[] },
    _dto: { branch_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('branch_to_hq');
  }

  /**
   * HQ pays a market a lump sum — FIFO-settles the market's oldest
   * BRANCH_SETTLED orders (HQ → market): MAIN down, market owed-balance down.
   */
  async settleHqToMarket(
    _requester: { id: string; roles?: string[] },
    _dto: { market_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('hq_to_market');
  }
}
