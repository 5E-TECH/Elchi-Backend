import { createHash } from 'crypto';
import { QueryFailedError } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * jtB0i4y3 — naqd pul hisob-kitobi (kuryer→filial→HQ→market) "Faoliyat
 * jurnali"ga yoziladi: `entity_type=Settlement`, metadata'da bo'g'in + summa.
 *
 *  • muvaffaqiyatli advance — `activityLog.log` BIR marta, amount+leg bilan;
 *  • advance yiqilsa (commit yo'q) — log YOZILMAYDI;
 *  • M8 takrori (token allaqachon qo'llangan) — log YOZILMAYDI;
 *  • `activityLog.log` throw qilsa ham natija qaytadi (fail-open).
 *
 * Harness — `fix3-settlement-advance-reclaim.spec.ts` dagi xotiradagi
 * daftar (FIFO haqiqiy kod bilan ishlaydi).
 */

const uniqueViolation = () => {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
};

function makeService(rows: Partial<OrderSettlement>[]) {
  const store = rows.map((r, i) => ({
    id: String(i + 1),
    status: SettlementStatus.PENDING,
    courier_amount: 0,
    branch_amount: 0,
    market_amount: 0,
    isDeleted: false,
    ...r,
  })) as OrderSettlement[];
  const carryStore: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: object = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const settlementRepo = {
    find: jest.fn((o: { where?: object }) =>
      Promise.resolve(
        store
          .filter((row) => matches(row as never, o?.where))
          .sort((a, b) => Number(a.id) - Number(b.id)),
      ),
    ),
    findOne: jest.fn(
      (o: { where?: object }) =>
        store.find((row) => matches(row as never, o?.where)) ?? null,
    ),
    update: jest.fn((criteria: { id: string }, patch: object) => {
      const row = store.find((r) => r.id === criteria.id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    createQueryBuilder: jest.fn(),
  };
  const carryRepo = {
    createQueryBuilder: jest.fn(() => {
      let values: Record<string, unknown> = {};
      const qb = {
        insert: () => qb,
        values: (v: Record<string, unknown>) => {
          values = v;
          return qb;
        },
        orIgnore: () => qb,
        execute: () => {
          if (
            !carryStore.some(
              (c) => c.level === values.level && c.party_id === values.party_id,
            )
          ) {
            carryStore.push({
              id: String(carryStore.length + 1),
              isDeleted: false,
              ...values,
            });
          }
          return Promise.resolve({});
        },
      };
      return qb;
    }),
    findOne: jest.fn(
      (o: { where?: object }) =>
        carryStore.find((c) => matches(c, o?.where)) ?? null,
    ),
    find: jest.fn((o: { where?: object }) =>
      Promise.resolve(carryStore.filter((c) => matches(c, o?.where))),
    ),
    update: jest.fn((criteria: { id: string }, patch: object) => {
      const row = carryStore.find((c) => c.id === criteria.id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
  };

  const committed = new Map<string, Record<string, unknown>>();
  let staged = new Map<string, Record<string, unknown>>();
  const txIdemRepo = {
    insert: jest.fn((row: Record<string, unknown>) => {
      const key = String(row.key);
      if (committed.has(key) || staged.has(key)) {
        return Promise.reject(uniqueViolation());
      }
      staged.set(key, { ...row, response: null });
      return Promise.resolve({});
    }),
    update: jest.fn(
      (criteria: { key: string }, patch: Record<string, unknown>) => {
        const row = staged.get(criteria.key);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
    ),
  };
  const idemRepo = {
    findOne: jest.fn((o: { where: { key: string } }) =>
      Promise.resolve(committed.get(o.where.key) ?? null),
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      staged = new Map();
    }),
    commitTransaction: jest.fn(() => {
      staged.forEach((row, key) => committed.set(key, row));
      staged = new Map();
    }),
    rollbackTransaction: jest.fn(() => {
      staged = new Map();
    }),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === OrderSettlementCarry) return carryRepo;
        if (entity === IdempotencyKey) return txIdemRepo;
        return settlementRepo;
      }),
    },
  };
  const dataSource = {
    options: { schema: 'order_schema' },
    createQueryRunner: jest.fn(() => queryRunner),
    query: jest.fn().mockResolvedValue([{ t: 'order_settlement_carry' }]),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderSettlementCarry) return carryRepo;
      if (entity === IdempotencyKey) return idemRepo;
      return settlementRepo;
    }),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new OrderSettlementService(
    dataSource as never,
    settlementRepo as never,
    {} as never,
    undefined,
    undefined,
    activityLog as never,
  );
  return { service, store, activityLog, settlementRepo, queryRunner };
}

const rowsOf = (): Partial<OrderSettlement>[] => [
  { order_id: '101', courier_id: '263', branch_id: '10', courier_amount: 60 },
  { order_id: '102', courier_id: '263', branch_id: '10', courier_amount: 50 },
];

const appliedKey = (token: string) =>
  `order.settlement.advance.applied:${createHash('sha256')
    .update(token)
    .digest('hex')}`;

describe('jtB0i4y3 — settlement audit izi', () => {
  it('⭐ courier_to_branch muvaffaqiyatli — activityLog.log BIR marta, metadata`da amount + leg', async () => {
    const { service, activityLog } = makeService(rowsOf());

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 150,
      requester_id: '7',
      request_id: 'tok-a1',
    })) as { data: Record<string, unknown> };

    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    const entry = activityLog.log.mock.calls[0][0];
    expect(entry).toEqual(
      expect.objectContaining({
        entity_type: 'Settlement',
        entity_id: '263',
        action: 'created',
        user_id: '7',
      }),
    );
    expect(entry.metadata).toEqual(
      expect.objectContaining({
        leg: 'courier_to_branch',
        kind: 'advance',
        amount: 150,
        allocated: 110,
        leftover: 40,
        settled_count: 2,
        settled_order_ids: ['101', '102'],
        request_id: 'tok-a1',
      }),
    );
    expect(entry.description).toBe(
      "Hisob-kitob (kuryer → filial) #263: 150 so'm, 2 ta buyurtma yopildi",
    );
  });

  it('branch_to_hq va hq_to_market bo`g`inlari ham yoziladi (leg mos)', async () => {
    const { service, activityLog } = makeService([
      {
        order_id: '201',
        courier_id: '263',
        branch_id: '10',
        market_id: '501',
        status: SettlementStatus.COURIER_SETTLED,
        branch_amount: 70,
      },
      {
        order_id: '202',
        courier_id: '263',
        branch_id: '10',
        market_id: '501',
        status: SettlementStatus.BRANCH_SETTLED,
        market_amount: 40,
      },
    ]);

    await service.advanceSettlement({
      level: 'branch_to_hq',
      match_value: '10',
      amount: 70,
      requester_id: '8',
      request_id: 'tok-b1',
    });
    await service.advanceSettlement({
      level: 'hq_to_market',
      match_value: '501',
      amount: 40,
      requester_id: '1',
      request_id: 'tok-b2',
    });

    const legs = activityLog.log.mock.calls.map(
      ([entry]: [{ entity_id: string; metadata: { leg: string } }]) => [
        entry.entity_id,
        entry.metadata.leg,
      ],
    );
    expect(legs).toEqual(
      expect.arrayContaining([
        ['10', 'branch_to_hq'],
        ['501', 'hq_to_market'],
      ]),
    );
  });

  it('⭐ settlement muvaffaqiyatsiz (commit yo`q) — log YOZILMAYDI', async () => {
    const { service, activityLog, settlementRepo, queryRunner } =
      makeService(rowsOf());
    settlementRepo.find.mockRejectedValueOnce(
      new Error('Connection terminated unexpectedly'),
    );

    await expect(
      service.advanceSettlement({
        level: 'courier_to_branch',
        match_value: '263',
        amount: 110,
        requester_id: '7',
        request_id: 'tok-c1',
      }),
    ).rejects.toThrow('Connection terminated unexpectedly');
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('M8 takrori (token allaqachon qo`llangan) — ikkinchi marta yozilmaydi', async () => {
    const { service, activityLog } = makeService(rowsOf());
    const payload = {
      level: 'courier_to_branch' as const,
      match_value: '263',
      amount: 110,
      requester_id: '7',
      request_id: 'tok-d1',
    };
    await service.advanceSettlement(payload);
    await service.advanceSettlement(payload);
    expect(appliedKey('tok-d1')).toContain('order.settlement.advance.applied');
    expect(activityLog.log).toHaveBeenCalledTimes(1);
  });

  it('⭐ activityLog.log throw qilsa ham settlement natijasi qaytadi (fail-open)', async () => {
    const { service, activityLog, store } = makeService(rowsOf());
    activityLog.log.mockRejectedValueOnce(new Error('audit db down'));

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 110,
      requester_id: '7',
      request_id: 'tok-e1',
    })) as { data: Record<string, unknown>; message: string };

    expect(res.message).toBe('Settlement advanced');
    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(store.map((r) => r.status)).toEqual([
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.COURIER_SETTLED,
    ]);
  });

  it('`system` (outbox relay) — user_id NULL, summa 0 bo`lsa hech narsa yozilmaydi', async () => {
    const { service, activityLog } = makeService(rowsOf());
    await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 0,
    });
    expect(activityLog.log).not.toHaveBeenCalled();

    await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 60,
      request_id: 'tok-f1',
    });
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log.mock.calls[0][0].user_id).toBeNull();
  });
});
