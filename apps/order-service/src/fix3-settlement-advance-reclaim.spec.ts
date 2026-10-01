/**
 * `executeIdempotent` — modul funksiyasi. Haqiqiy implementatsiya ishlaydi,
 * lekin controller unga qanday opsiyalar uzatganini ko'rish uchun spy bilan
 * o'raladi.
 */
jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return { ...actual, executeIdempotent: jest.fn(actual.executeIdempotent) };
});

import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import {
  IdempotencyKey,
  IdempotencyService,
  SettlementStatus,
  executeIdempotent as executeIdempotentFn,
} from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * Audit M8 — yiqilgan settlement advance abadiy keshlanib qolmasin, lekin
 * qayta ishga tushganda to'lov IKKI MARTA qo'llanmasin.
 *
 *  • controller: `order.settlement.advance` — `reclaimFailed: true` (faqat
 *    shu handler; boshqalar baytma-bayt o'zgarmaydi);
 *  • servis: token'ning "applied" belgisi FIFO commit'i bilan atomik —
 *    commit'dan keyin qayta ishga tushgan handler hech narsa qilmaydi.
 */

const stub = <T>(value: unknown): T => value as T;
const executeIdempotent = jest.mocked(executeIdempotentFn);
const ctx = stub<RmqContext>({});

const uniqueViolation = () => {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
};

/**
 * Xotiradagi `idempotency_keys` — haqiqiy IdempotencyService (va
 * `reclaimFinished` UPDATE himoyasi) shu ustida ishlaydi.
 */
function makeIdempotencyRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  const repo = {
    rows,
    insert: jest.fn((row: Record<string, unknown>) => {
      if (rows.has(String(row.key))) {
        return Promise.reject(uniqueViolation());
      }
      rows.set(String(row.key), {
        ...row,
        response: null,
        error: null,
        created_at: new Date(),
        completed_at: null,
      });
      return Promise.resolve({});
    }),
    findOne: jest.fn((opts: { where: { key: string } }) =>
      Promise.resolve(rows.get(opts.where.key) ?? null),
    ),
    update: jest.fn(
      (criteria: { key: string }, patch: Record<string, unknown>) => {
        const row = rows.get(criteria.key);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
    ),
    createQueryBuilder: jest.fn(() => {
      const params: Record<string, unknown> = {};
      let patch: Record<string, unknown> = {};
      const qb = {
        update: () => qb,
        set: (value: Record<string, unknown>) => {
          patch = value;
          return qb;
        },
        where: (_sql: string, p: Record<string, unknown>) => {
          Object.assign(params, p);
          return qb;
        },
        andWhere: (_sql: string, p: Record<string, unknown>) => {
          Object.assign(params, p);
          return qb;
        },
        execute: () => {
          const row = rows.get(String(params.key));
          if (!row || (params.status && row.status !== params.status)) {
            return Promise.resolve({ affected: 0 });
          }
          row.status = patch.status;
          row.response = null;
          row.error = null;
          row.completed_at = null;
          row.created_at = new Date();
          return Promise.resolve({ affected: 1 });
        },
      };
      return qb;
    }),
  };
  return repo;
}

function makeController(settlementService: Record<string, jest.Mock>) {
  const rmqService = {
    ack: jest.fn(),
    nack: jest.fn(),
    nackForError: jest.fn(),
  };
  const idemRepo = makeIdempotencyRepo();
  const idempotencyService = new IdempotencyService(idemRepo as never);
  const lifecycle = {
    sellOrder: jest.fn(),
  };
  const controller = new OrderServiceController(
    stub(rmqService),
    stub({}),
    stub({}),
    stub({}),
    stub(settlementService),
    stub(lifecycle),
    idempotencyService,
    stub({ resolve: jest.fn() }),
  );
  return { controller, rmqService, idemRepo, lifecycle };
}

const ADVANCE = {
  level: 'courier_to_branch' as const,
  match_value: '263',
  amount: 500000,
  requester_id: '7',
  request_id: 'pay-token-1',
};

beforeEach(() => {
  executeIdempotent.mockClear();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('M8 — controller: order.settlement.advance reclaimFailed', () => {
  it('advance — executeIdempotent ga reclaimFailed: true uzatiladi', async () => {
    const advanceSettlement = jest.fn().mockResolvedValue({ data: {} });
    const { controller } = makeController({ advanceSettlement });

    await controller.settlementAdvance(ADVANCE, ctx);

    expect(executeIdempotent).toHaveBeenCalledTimes(1);
    expect(executeIdempotent.mock.calls[0][3]).toEqual({
      requestId: 'pay-token-1',
      pattern: 'order.settlement.advance',
      reclaimFailed: true,
    });
    expect(advanceSettlement).toHaveBeenCalledWith(ADVANCE);
  });

  it('boshqa handlerlar (order.sell) — opsiyalar AYNAN { requestId, pattern }', async () => {
    const { controller, lifecycle } = makeController({});
    lifecycle.sellOrder.mockResolvedValue({ data: { id: '1' } });

    await controller.sell(
      {
        id: '1',
        dto: {},
        requester: { id: '9', roles: ['courier'] },
        request_id: 'sell-1',
      },
      ctx,
    );

    const opts = executeIdempotent.mock.calls[0][3] as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(opts).sort()).toEqual(['pattern', 'requestId']);
  });

  it('⭐ tranzient xato kalitni zaharlamaydi: keyingi outbox urinishi handlerni QAYTA ishlatadi', async () => {
    const advanceSettlement = jest
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ statusCode: 200, data: { allocated: 500000 } });
    const { controller, idemRepo } = makeController({ advanceSettlement });
    const key = 'order.settlement.advance:pay-token-1';

    // 1-urinish: postgres qayta ishga tushmoqda — handler yiqiladi.
    await expect(controller.settlementAdvance(ADVANCE, ctx)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
    expect(idemRepo.rows.get(key)?.status).toBe('failed');

    // 2-urinish (o'sha request_id): ilgari keshlangan xato qaytardi.
    const res = await controller.settlementAdvance(ADVANCE, ctx);
    expect(res).toEqual({ statusCode: 200, data: { allocated: 500000 } });
    expect(advanceSettlement).toHaveBeenCalledTimes(2);
    expect(idemRepo.rows.get(key)?.status).toBe('completed');

    // 3-urinish — keshdan, handler qayta ishlamaydi.
    await controller.settlementAdvance(ADVANCE, ctx);
    expect(advanceSettlement).toHaveBeenCalledTimes(2);
  });

  it('reclaimFailed faqat advance uchun: order.sell yiqilgan kalitni avvalgidek keshdan qaytaradi', async () => {
    const { controller, lifecycle } = makeController({});
    lifecycle.sellOrder.mockRejectedValueOnce(new Error('boom'));
    const payload = {
      id: '1',
      dto: {},
      requester: { id: '9', roles: ['courier'] },
      request_id: 'sell-2',
    };

    await expect(controller.sell(payload, ctx)).rejects.toThrow('boom');
    await expect(controller.sell(payload, ctx)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(lifecycle.sellOrder).toHaveBeenCalledTimes(1);
  });
});

describe('M8 — servis: advance tokenining "applied" belgisi', () => {
  const appliedKey = (token: string) =>
    `order.settlement.advance.applied:${createHash('sha256')
      .update(token)
      .digest('hex')}`;

  function makeService(
    rows: Partial<OrderSettlement>[],
    opts: { carryTable?: boolean } = {},
  ) {
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
                (c) =>
                  c.level === values.level && c.party_id === values.party_id,
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

    // idempotency_keys: tranzaksiya ichidagi yozuv faqat COMMIT'da ko'rinadi.
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
      query: jest
        .fn()
        .mockResolvedValue([
          { t: opts.carryTable === false ? null : 'order_settlement_carry' },
        ]),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === OrderSettlementCarry) return carryRepo;
        if (entity === IdempotencyKey) return idemRepo;
        return settlementRepo;
      }),
    };
    const service = new OrderSettlementService(
      dataSource as never,
      settlementRepo as never,
      {} as never,
    );
    const carryOf = (party: string) =>
      Number(
        carryStore.find(
          (c) => c.level === 'courier_to_branch' && c.party_id === party,
        )?.amount ?? 0,
      );
    return {
      service,
      store,
      carryOf,
      committed,
      settlementRepo,
      txIdemRepo,
      idemRepo,
      queryRunner,
      dataSource,
    };
  }

  const rowsOf = (): Partial<OrderSettlement>[] => [
    { order_id: '101', courier_id: '263', branch_id: '10', courier_amount: 60 },
    { order_id: '102', courier_id: '263', branch_id: '10', courier_amount: 50 },
  ];

  it('belgi FIFO tranzaksiyasining BIRINCHI yozuvi va commit bilan natija saqlanadi', async () => {
    const { service, committed, txIdemRepo, settlementRepo } =
      makeService(rowsOf());

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 150,
      requester_id: '7',
      request_id: 'tok-1',
    })) as { data: Record<string, unknown> };

    expect(res.data).toEqual({
      settled_order_ids: ['101', '102'],
      allocated: 110,
      leftover: 40,
    });
    // Tranzaksiyadagi birinchi yozuv — belgi (qatorlar o'qilishidan oldin).
    expect(txIdemRepo.insert.mock.invocationCallOrder[0]).toBeLessThan(
      settlementRepo.find.mock.invocationCallOrder[0],
    );
    const marker = committed.get(appliedKey('tok-1'));
    expect(marker).toEqual(
      expect.objectContaining({
        pattern: 'order.settlement.advance.applied',
        status: 'completed',
        response: {
          settled_order_ids: ['101', '102'],
          allocated: 110,
          leftover: 40,
        },
      }),
    );
    // Kalit token uzunligidan qat'i nazar 200 belgidan qisqa.
    expect(appliedKey('x'.repeat(500)).length).toBe(97);
  });

  it('⭐ commit o`tgandan keyin qayta ishga tushish (markCompleted yo`qolgan) — to`lov IKKINCHI marta qo`llanmaydi', async () => {
    const { service, store, carryOf, settlementRepo, queryRunner } =
      makeService([
        ...rowsOf(),
        {
          order_id: '103',
          courier_id: '263',
          branch_id: '10',
          courier_amount: 40,
        },
      ]);
    const payload = {
      level: 'courier_to_branch' as const,
      match_value: '263',
      amount: 120,
      requester_id: '7',
      request_id: 'tok-2',
    };

    const first = (await service.advanceSettlement(payload)) as {
      data: Record<string, unknown>;
    };
    expect(first.data.settled_order_ids).toEqual(['101', '102']);
    expect(carryOf('263')).toBe(10);

    const second = (await service.advanceSettlement(payload)) as {
      message: string;
      data: Record<string, unknown>;
    };

    expect(second.message).toBe('Settlement already advanced');
    expect(second.data).toEqual({
      settled_order_ids: ['101', '102'],
      allocated: 110,
      leftover: 10,
      replayed: true,
    });
    // FIFO qayta ishlamadi: 103 hamon PENDING, qoldiq 20 ga oshmadi.
    expect(store[2].status).toBe(SettlementStatus.PENDING);
    expect(carryOf('263')).toBe(10);
    expect(settlementRepo.find).toHaveBeenCalledTimes(1);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
  });

  it('⭐ parallel ikkinchi nusxa: belgi UNIQUE da to`qnashadi → rollback, hech narsa o`zgarmaydi', async () => {
    const { service, store, idemRepo, txIdemRepo, queryRunner } =
      makeService(rowsOf());
    const key = appliedKey('tok-3');
    const storedRow = {
      key,
      status: 'completed',
      response: { settled_order_ids: ['101'], allocated: 60, leftover: 0 },
    };
    // Tezkor tekshiruvda hali ko'rinmaydi (birinchisi commit qilinmoqda),
    // INSERT esa birinchisi commit bo'lgach UNIQUE bilan yiqiladi.
    idemRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedRow);
    txIdemRepo.insert.mockRejectedValueOnce(uniqueViolation());

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 60,
      requester_id: '7',
      request_id: 'tok-3',
    })) as { data: Record<string, unknown> };

    expect(res.data).toEqual({
      settled_order_ids: ['101'],
      allocated: 60,
      leftover: 0,
      replayed: true,
    });
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(store.map((row) => row.status)).toEqual([
      SettlementStatus.PENDING,
      SettlementStatus.PENDING,
    ]);
  });

  it('commit`dan OLDINgi xato — belgi saqlanmaydi, keyingi urinish to`lovni bir marta qo`llaydi', async () => {
    const { service, store, committed, settlementRepo } = makeService(rowsOf());
    settlementRepo.find.mockRejectedValueOnce(
      new Error('Connection terminated unexpectedly'),
    );
    const payload = {
      level: 'courier_to_branch' as const,
      match_value: '263',
      amount: 110,
      requester_id: '7',
      request_id: 'tok-4',
    };

    await expect(service.advanceSettlement(payload)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
    expect(committed.has(appliedKey('tok-4'))).toBe(false);

    const res = (await service.advanceSettlement(payload)) as {
      data: Record<string, unknown>;
    };
    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(store.map((row) => row.status)).toEqual([
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.COURIER_SETTLED,
    ]);
    expect(committed.has(appliedKey('tok-4'))).toBe(true);
  });

  it('request_id siz (eski chaqiruvchi) — belgi yo`q, xatti-harakat avvalgidek', async () => {
    const { service, dataSource, txIdemRepo } = makeService(rowsOf());

    const res = (await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 110,
      requester_id: '7',
    })) as { data: Record<string, unknown> };

    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(txIdemRepo.insert).not.toHaveBeenCalled();
    expect(dataSource.getRepository).not.toHaveBeenCalledWith(IdempotencyKey);
  });

  it('belgini o`qish xatosi yutilmaydi (handler yiqiladi → reclaimFailed qayta tekshiradi)', async () => {
    const { service, idemRepo, settlementRepo } = makeService(rowsOf());
    idemRepo.findOne.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(
      service.advanceSettlement({
        level: 'courier_to_branch',
        match_value: '263',
        amount: 110,
        requester_id: '7',
        request_id: 'tok-5',
      }),
    ).rejects.toThrow('pool exhausted');
    expect(settlementRepo.find).not.toHaveBeenCalled();
  });

  it("requester_id yo'q / raqam emas — `*_by` NULL (bigint ustunda 22P02 bilan abadiy yiqilmaydi)", async () => {
    const { service, store } = makeService(rowsOf());

    await service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 60,
      request_id: 'tok-6',
    });
    expect(store[0].courier_to_branch_by).toBeNull();

    const other = makeService(rowsOf());
    await other.service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '263',
      amount: 60,
      requester_id: '17',
      request_id: 'tok-7',
    });
    expect(other.store[0].courier_to_branch_by).toBe('17');
  });
});
