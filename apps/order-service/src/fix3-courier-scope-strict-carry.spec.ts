import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { Order } from './entities/order.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * CODE-28 — `order.settlement.courier_scope` ning `carry_amount` i QAT'IY
 * o'qiladi. Ilgari `loadCarries` har qanday xatoni yutib `[]` qaytarardi:
 * baza xatosida HQ kuryerining qabul ko'rinishi qoldiqni jimgina tashlab
 * yuborardi. Endi xato RpcException 500 bo'lib chiqadi (gateway uni
 * "tekshirib bo'lmadi" deb ko'rsatadi va pulni ko'chirmaydi).
 */
describe('CODE-28 — kuryer kesimida qoldiq qat`iy o`qiladi', () => {
  type Carry = Partial<OrderSettlementCarry>;

  function makeService(carries: Carry[] = []) {
    const scopeQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ branch_id: null, count: '1', amount: '50000' }]),
    };
    const settlementRepo = { createQueryBuilder: jest.fn(() => scopeQb) };
    const carryStore = carries.map((carry, i) => ({
      id: String(i + 1),
      branch_id: null,
      isDeleted: false,
      ...carry,
    }));
    const carryRepo = {
      find: jest.fn((options: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          carryStore.filter((row) =>
            Object.entries(options?.where ?? {}).every(
              ([key, value]) => (row as Record<string, unknown>)[key] === value,
            ),
          ),
        ),
      ),
    };
    const orderRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const method of [
          'where',
          'andWhere',
          'select',
          'addSelect',
          'orderBy',
          'limit',
        ]) {
          qb[method] = jest.fn(() => qb);
        }
        qb.getCount = jest.fn().mockResolvedValue(0);
        qb.getRawMany = jest.fn().mockResolvedValue([]);
        return qb;
      }),
    };
    const approvalRepo = { count: jest.fn().mockResolvedValue(0) };
    const dataSource = {
      options: { schema: 'order_schema' },
      query: jest.fn().mockResolvedValue([{ t: 'order_settlement_carry' }]),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === OrderSettlementCarry) return carryRepo;
        if (entity === Order) return orderRepo;
        if (entity === OrderExtraCostApproval) return approvalRepo;
        throw new Error('kutilmagan repository');
      }),
    };
    const service = new OrderSettlementService(
      dataSource as never,
      settlementRepo as never,
      {} as never,
    );
    return { service, carryRepo, dataSource, scopeQb };
  }

  const rpcErrorOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => {
        throw new Error('rad etilishi kutilgandi');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('qoldiq faqat shu kuryerniki, qat`iy so`rov bilan (level + party_id + isDeleted)', async () => {
    const { service, carryRepo } = makeService([
      { level: 'courier_to_branch', party_id: '263', amount: 15000 },
      { level: 'courier_to_branch', party_id: '999', amount: 70000 },
      { level: 'branch_to_hq', party_id: '263', amount: 5000 },
    ]);

    const res = (await service.getCourierSettlementScope({
      courier_id: '263',
    })) as { data: { carry_amount: number; hq_pending_amount: number } };

    expect(res.data.carry_amount).toBe(15000);
    expect(res.data.hq_pending_amount).toBe(50000);
    expect(carryRepo.find).toHaveBeenCalledWith({
      where: {
        level: 'courier_to_branch',
        party_id: '263',
        isDeleted: false,
      },
    });
  });

  it('⭐ qoldiq o`qish xatosi — 0 EMAS, RpcException 500 (o`zbekcha)', async () => {
    const { service, carryRepo } = makeService([
      { level: 'courier_to_branch', party_id: '263', amount: 15000 },
    ]);
    carryRepo.find.mockRejectedValueOnce(new Error('connection reset'));

    const err = await rpcErrorOf(
      service.getCourierSettlementScope({ courier_id: '263' }),
    );

    expect(err).toEqual({
      statusCode: 500,
      message:
        "Kuryer hisob-kitob holatini o'qib bo'lmadi (ma'lumotlar bazasi xatosi)",
    });
  });

  it('jadval mavjudligini tekshirish xatosi ham yutilmaydi — 500', async () => {
    const { service, dataSource } = makeService();
    dataSource.query.mockRejectedValueOnce(new Error('statement timeout'));

    const err = await rpcErrorOf(
      service.getCourierSettlementScope({ courier_id: '263' }),
    );

    expect(err.statusCode).toBe(500);
  });

  it('yutilgan xatodan qolgan `false` kesh qoldiqni yashirmaydi', async () => {
    const { service, dataSource } = makeService([
      { level: 'courier_to_branch', party_id: '263', amount: 15000 },
    ]);
    (
      service as unknown as { carryTableReady: boolean | null }
    ).carryTableReady = false;
    (service as unknown as { carryCheckedAt: number }).carryCheckedAt =
      Date.now();

    const res = (await service.getCourierSettlementScope({
      courier_id: '263',
    })) as { data: { carry_amount: number } };

    expect(dataSource.query).toHaveBeenCalledWith(
      'SELECT to_regclass($1) AS t',
      ['order_schema.order_settlement_carry'],
    );
    expect(res.data.carry_amount).toBe(15000);
  });

  it("jadval haqiqatan yo'q (migratsiya ishlamagan) — 0, xato yo'q", async () => {
    const { service, dataSource, carryRepo } = makeService([
      { level: 'courier_to_branch', party_id: '263', amount: 15000 },
    ]);
    dataSource.query.mockResolvedValue([{ t: null }]);

    const res = (await service.getCourierSettlementScope({
      courier_id: '263',
    })) as { data: { carry_amount: number } };

    expect(res.data.carry_amount).toBe(0);
    expect(carryRepo.find).not.toHaveBeenCalled();
  });

  it('handleDbError tanigan xato (22P02 → 400) o`zgarishsiz o`tadi', async () => {
    const { service, scopeQb } = makeService();
    scopeQb.getRawMany.mockRejectedValueOnce(
      new QueryFailedError(
        'SELECT 1',
        [],
        Object.assign(new Error('invalid input syntax for type bigint'), {
          code: '22P02',
        }),
      ),
    );

    const err = await rpcErrorOf(
      service.getCourierSettlementScope({ courier_id: '263' }),
    );

    expect(err.statusCode).toBe(400);
  });

  it('o`tkazish tekshiruvi qoldiqni BIR marta o`qiydi va o`z xabarini saqlaydi', async () => {
    const ok = makeService([
      { level: 'courier_to_branch', party_id: '263', amount: 15000 },
    ]);
    const res = (await ok.service.getCourierTransferCheck({
      courier_id: '263',
    })) as { data: { carry_amount: number } };
    expect(res.data.carry_amount).toBe(15000);
    expect(ok.carryRepo.find).toHaveBeenCalledTimes(1);

    const failing = makeService();
    failing.carryRepo.find.mockRejectedValueOnce(new Error('connection reset'));
    const err = await rpcErrorOf(
      failing.service.getCourierTransferCheck({ courier_id: '263' }),
    );
    expect(err.statusCode).toBe(500);
    expect(err.message).toContain("Kuryer o'tkazish tekshiruvini");
  });
});
