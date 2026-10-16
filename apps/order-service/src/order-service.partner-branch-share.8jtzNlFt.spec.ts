/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { from, of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import {
  Cashbox_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderLookupService } from './lookup/order-lookup.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import { computeSellProfit } from './domain/order-money';
import { createMemoryBranchService } from '../../branch-service/test/branch-memory-repo';

/**
 * 8jtzNlFt — hamkor filial ulushi REAL MA'LUMOT bilan.
 *
 * Ilgari `resolveBranchShare` testlari faqat qo'lda yasalgan
 * `{ ownership: 'partner', per_order_share: 7000 }` javobiga tayanardi,
 * haqiqatda esa hech bir filial PARTNER bo'la olmasdi (DTO'da maydon yo'q).
 * Bu yerda: filial HAQIQIY branch-service `createBranch` bilan
 * (ownership='partner', per_order_share=5000) yaratiladi, order-service
 * `OrderLookupService.resolveBranchShare` uni `branch.find_by_id` RPC
 * kontrakti orqali (HAQIQIY `findBranchById`) o'qiydi, so'ng HAQIQIY
 * `sellOrder` settlement daftariga `branch_amount = total − courierShare −
 * 5000` yozadi. Kassa ↔ settlement identikligi ham saqlanadi.
 */

type Row = Record<string, any>;

const ADMIN = { id: '1', roles: ['admin'] };

/** Real branch-service + RMQ kontrakti (RpcException → {statusCode,...}). */
async function branchWorld() {
  const world = createMemoryBranchService();
  const hq: any = await world.service.createBranch(
    { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
    ADMIN,
  );
  const partner: any = await world.service.createBranch(
    {
      name: 'Hamkor Samarqand',
      type: 'REGIONAL',
      code: 'SAM-P',
      parent_id: String(hq.data.id),
      ownership: 'partner',
      per_order_share: '5000',
    },
    ADMIN,
  );
  const owned: any = await world.service.createBranch(
    {
      name: 'Andijon',
      type: 'REGIONAL',
      code: 'AND',
      parent_id: String(hq.data.id),
    },
    ADMIN,
  );
  const send = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd !== 'branch.find_by_id') {
      throw new Error('kutilmagan cmd ' + pattern.cmd);
    }
    return from(
      world.service
        .findBranchById(payload.id, payload.requester)
        .catch((error: unknown) => {
          throw error instanceof RpcException ? error.getError() : error;
        }),
    );
  });
  const lookup = new OrderLookupService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { send } as never,
  );
  return {
    world,
    lookup,
    send,
    partnerId: String(partner.data.id),
    ownedId: String(owned.data.id),
  };
}

describe('8jtzNlFt — resolveBranchShare real filial ma`lumoti bilan', () => {
  it('⭐ PARTNER filial (createBranch: partner/5000) → 5000', async () => {
    const { lookup, partnerId, send } = await branchWorld();

    await expect(lookup.resolveBranchShare(partnerId)).resolves.toBe(5000);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      { id: partnerId, requester: { id: 'system', roles: ['superadmin'] } },
    );
  });

  it('⭐ OWNED filial (sukut) → 0', async () => {
    const { lookup, ownedId } = await branchWorld();
    await expect(lookup.resolveBranchShare(ownedId)).resolves.toBe(0);
  });

  it('PARTNER → OWNED ga o`tkazilsa → 0; ulush o`zgarsa → yangi ulush', async () => {
    const { lookup, world, partnerId } = await branchWorld();

    await world.service.updateBranch(
      partnerId,
      { per_order_share: '6500' },
      ADMIN,
    );
    await expect(lookup.resolveBranchShare(partnerId)).resolves.toBe(6500);

    await world.service.updateBranch(partnerId, { ownership: 'owned' }, ADMIN);
    await expect(lookup.resolveBranchShare(partnerId)).resolves.toBe(0);
  });

  it('o`chirilgan / yo`q filial (404) → 0', async () => {
    const { lookup } = await branchWorld();
    await expect(lookup.resolveBranchShare('99999')).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sotuv: money-conservation-ledger.spec harnessi (xotiradagi tranzaksiyali
// daftar), lekin `resolveBranchShare` — HAQIQIY lookup + HAQIQIY branch-service.
// ---------------------------------------------------------------------------
const signed = (h: Row): number =>
  h.operation_type === 'income'
    ? Number(h.amount)
    : h.operation_type === 'expense'
      ? -Number(h.amount)
      : 0;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const sum = (values: number[]): number =>
  round2(values.reduce((acc, v) => acc + Number(v), 0));

const MARKET = {
  id: '121',
  tariff_center: 45000,
  tariff_home: 70000,
  expense_proof_conditions: [],
};
const COURIER_ROW = {
  id: '301',
  tariff_center: 30000,
  tariff_home: 50000,
  can_add_extra_cost: true,
  can_sell_cancel: true,
};
const COURIER = { id: '301', roles: ['courier'], branch_id: null };

function makeSaleWorld(
  lookupReal: OrderLookupService,
  orders: Row[],
): {
  s: Row;
  cashboxHistory: Row[];
  settlements: Row[];
  outbox: Row[];
  orders: Map<string, Row>;
} {
  const cashboxHistory: Row[] = [];
  const settlements: Row[] = [];
  const outboxRows: Row[] = [];
  const orderMap = new Map(orders.map((o) => [String(o.id), { ...o }]));
  const pending = new WeakMap<object, Array<() => void>>();
  let seq = 0;

  const createQueryRunner = () => {
    const ops: Array<() => void> = [];
    const settlementRepo = {
      findOne: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          settlements.find((r) => r.order_id === String(where.order_id)) ??
            null,
        ),
      ),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => {
        const saved = { id: `S${++seq}`, ...row };
        ops.push(() => settlements.push(saved));
        return Promise.resolve(saved);
      }),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
      ),
    };
    pending.set(manager, ops);
    return {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(() => {
        ops.splice(0).forEach((apply) => apply());
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        ops.splice(0);
        return Promise.resolve();
      }),
      release: jest.fn(),
    };
  };
  const write = (manager: object | undefined, apply: () => void) => {
    const ops = manager ? pending.get(manager) : undefined;
    if (ops) ops.push(apply);
    else apply();
  };
  const cashboxBalance = (userId: string, type: Cashbox_type): number =>
    sum(
      cashboxHistory
        .filter((h) => h.user_id === userId && h.cashbox_type === type)
        .map(signed),
    );

  const s = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(createQueryRunner) },
    logisticsClient: {
      send: jest.fn((_pattern: unknown, payload: { id: string }) =>
        of({
          data: {
            id: payload.id,
            courier_id: String(payload.id).replace(/^P-/, ''),
          },
        }),
      ),
    },
    outbox: {
      enqueue: jest.fn(
        (
          _target: string,
          pattern: string,
          payload: Row,
          options?: { manager?: object },
        ) => {
          write(options?.manager, () => {
            outboxRows.push({ pattern, ...payload });
            if (pattern === 'finance.cashbox.update_balance') {
              cashboxHistory.push({ ...payload });
            }
          });
          return Promise.resolve(undefined);
        },
      ),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn(() => Promise.resolve([MARKET])),
      getCouriersByIds: jest.fn(() => Promise.resolve([COURIER_ROW])),
      getCashboxByUser: jest.fn((id: string, type: Cashbox_type) =>
        Promise.resolve({
          id: `${type}-${id}`,
          balance: cashboxBalance(String(id), type),
        }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn((order: Row) =>
        Promise.resolve(order.branch_id ?? null),
      ),
      // ⭐ HAQIQIY: OrderLookupService → branch.find_by_id → branch-service.
      resolveBranchShare: (branchId: string | null) =>
        lookupReal.resolveBranchShare(branchId),
    },
    findById: jest.fn((id: string) =>
      Promise.resolve({ ...orderMap.get(String(id)) }),
    ),
    updateFull: jest.fn(
      (id: string, patch: Row, _actor: unknown, manager?: object) => {
        write(manager, () =>
          Object.assign(orderMap.get(String(id)) ?? {}, patch),
        );
        return Promise.resolve(undefined);
      },
    ),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  return {
    s,
    cashboxHistory,
    settlements,
    outbox: outboxRows,
    orders: orderMap,
  };
}

const order = (id: string, branchId: string | null): Row => ({
  id,
  status: Order_status.WAITING,
  post_id: 'P-301',
  market_id: '121',
  total_price: 150000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: branchId,
  holder_branch_id: branchId,
  courier_id: '301',
  comment: null,
});

describe('⭐ 8jtzNlFt — PARTNER filialda sotuv: branch_amount = total − courierShare − 5000', () => {
  it('⭐ kuryer sotuvi (total 150 000, kuryer tarifi 30 000, filial ulushi 5 000) → branch_amount 115 000', async () => {
    const { lookup, partnerId } = await branchWorld();
    const w = makeSaleWorld(lookup, [order('7001', partnerId)]);

    await w.s.sellOrder(COURIER, '7001', {});

    expect(w.settlements).toHaveLength(1);
    expect(w.settlements[0]).toMatchObject({
      order_id: '7001',
      branch_id: partnerId,
      courier_amount: 150000 - 30000,
      branch_amount: 150000 - 30000 - 5000,
      market_amount: 150000 - 45000,
      status: SettlementStatus.PENDING,
    });
    // Ulush buyurtmaga SNAPSHOT qilinadi (rollback aynan shu bilan).
    expect(w.orders.get('7001')).toMatchObject({
      status: Order_status.SOLD,
      branch_share: 5000,
      courier_share: 30000,
    });
    // HQ foydasi (SELL_PROFIT) — `enqueueFinanceOnStatusChange` aynan shu
    // snapshotdan hisoblaydi: market tarifi − kuryer ulushi − filial ulushi.
    const sold = w.orders.get('7001')!;
    expect(
      computeSellProfit(
        Number(sold.market_tariff),
        Number(sold.courier_share),
        Number(sold.branch_share),
      ),
    ).toBe(45000 - 30000 - 5000);
  });

  it('OWNED filialda xuddi shu sotuv → branch_amount = total − courierShare (ulush 0)', async () => {
    const { lookup, ownedId } = await branchWorld();
    const w = makeSaleWorld(lookup, [order('7002', ownedId)]);

    await w.s.sellOrder(COURIER, '7002', {});

    expect(w.settlements[0]).toMatchObject({
      branch_amount: 150000 - 30000,
      courier_amount: 150000 - 30000,
    });
    expect(w.orders.get('7002')).toMatchObject({ branch_share: 0 });
  });

  it('pul saqlanadi: market + kuryer ulushi + filial ulushi + HQ foydasi = total', async () => {
    const { lookup, partnerId } = await branchWorld();
    const w = makeSaleWorld(lookup, [order('7003', partnerId)]);

    await w.s.sellOrder(COURIER, '7003', {});

    const settlement = w.settlements[0];
    const branchShare = settlement.courier_amount - settlement.branch_amount;
    const sold = w.orders.get('7003')!;
    const hqProfit = computeSellProfit(
      Number(sold.market_tariff),
      Number(sold.courier_share),
      Number(sold.branch_share),
    );
    expect(branchShare).toBe(5000);
    expect(
      settlement.market_amount + 30000 + branchShare + Number(hqProfit),
    ).toBe(150000);
    // Kassa ↔ settlement: market kassasi == market_amount, kuryer kassasi ==
    // courier_amount (check-cashbox-invariant identikligi).
    const balance = (type: Cashbox_type, userId: string) =>
      sum(
        w.cashboxHistory
          .filter((h) => h.cashbox_type === type && h.user_id === userId)
          .map(signed),
      );
    expect(balance(Cashbox_type.FOR_MARKET, '121')).toBe(
      settlement.market_amount,
    );
    expect(balance(Cashbox_type.FOR_COURIER, '301')).toBe(
      settlement.courier_amount,
    );
  });
});
