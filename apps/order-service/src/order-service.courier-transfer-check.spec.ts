import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { Brackets, QueryFailedError } from 'typeorm';
import { OrderServiceController } from './order-service.controller';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { Order } from './entities/order.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * R3 — `order.courier_transfer_check`: kuryerni filialdan filialga
 * o'tkazishdan oldin order-service'dagi hamma narsa (PENDING savdo, qat'iy
 * qoldiq, qo'lidagi buyurtmalar, qo'shimcha xarajat so'rovlari). branch-service
 * aynan shu nomni yuboradi — nom o'zgarsa o'tkazish 503 bilan to'xtaydi.
 */
describe('order.courier_transfer_check handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'courierTransferCheck',
  )?.value as (
    data: { courier_id?: string | null } | undefined,
    context: RmqContext,
  ) => Promise<unknown>;

  it("naqsh AYNAN { cmd: 'order.courier_transfer_check' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.courier_transfer_check' },
    ]);
  });

  it('payload servisga o`zgarishsiz uzatiladi, javob qaytadi', async () => {
    const reply = { data: { orders_in_hand: 0 } };
    const settlementService = {
      getCourierTransferCheck: jest.fn().mockResolvedValue(reply),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );
    const ctx = {} as RmqContext;

    const res = await handler.call(
      { executeAndAck, settlementService },
      { courier_id: '263' },
      ctx,
    );

    expect(res).toBe(reply);
    expect(executeAndAck).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(settlementService.getCourierTransferCheck).toHaveBeenCalledWith({
      courier_id: '263',
    });
  });

  it('payload bo`lmasa bo`sh obyekt uzatiladi', async () => {
    const settlementService = {
      getCourierTransferCheck: jest.fn().mockResolvedValue({ data: {} }),
    };

    await handler.call(
      {
        executeAndAck: (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
        settlementService,
      },
      undefined,
      {} as RmqContext,
    );

    expect(settlementService.getCourierTransferCheck).toHaveBeenCalledWith({});
  });
});

describe('OrderSettlementService.getCourierTransferCheck', () => {
  type Carry = Partial<OrderSettlementCarry>;
  const matches = (row: Record<string, unknown>, where: object = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  function makeService(
    opts: {
      scopeRows?: Array<{
        branch_id: string | null;
        count: string;
        amount: string;
      }>;
      carries?: Carry[];
      ordersInHand?: number;
      sample?: Array<{ id: string; status: string }>;
      approvals?: number;
    } = {},
  ) {
    const scopeQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(opts.scopeRows ?? []),
    };
    const settlementRepo = { createQueryBuilder: jest.fn(() => scopeQb) };

    const orderQbs: any[] = [];
    const orderRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(opts.ordersInHand ?? 0),
          getRawMany: jest.fn().mockResolvedValue(opts.sample ?? []),
        };
        orderQbs.push(qb);
        return qb;
      }),
    };
    const carryStore = (opts.carries ?? []).map((carry, i) => ({
      id: String(i + 1),
      branch_id: null,
      isDeleted: false,
      ...carry,
    }));
    const carryRepo = {
      find: jest.fn((options: { where?: object }) =>
        Promise.resolve(
          carryStore.filter((row) => matches(row, options?.where)),
        ),
      ),
    };
    const approvalRepo = {
      count: jest.fn().mockResolvedValue(opts.approvals ?? 0),
    };
    const dataSource = {
      options: { schema: 'order_schema' },
      query: jest.fn().mockResolvedValue([{ t: 'order_settlement_carry' }]),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Order) return orderRepo;
        if (entity === OrderExtraCostApproval) return approvalRepo;
        if (entity === OrderSettlementCarry) return carryRepo;
        throw new Error('kutilmagan repository');
      }),
    };

    const service = new OrderSettlementService(
      dataSource as any,
      settlementRepo as any,
      {} as any,
    );
    return {
      service,
      scopeQb,
      settlementRepo,
      orderRepo,
      orderQbs,
      carryRepo,
      approvalRepo,
      dataSource,
    };
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

  it('toza kuryer — hamma son nol, to`liq javob shakli', async () => {
    const { service } = makeService();

    const res: any = await service.getCourierTransferCheck({
      courier_id: '263',
    });

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Courier transfer check');
    expect(res.data).toEqual({
      hq_pending_count: 0,
      hq_pending_amount: 0,
      branch_pending_count: 0,
      branch_pending_amount: 0,
      branch_ids: [],
      courier_id: '263',
      pending_settlement_count: 0,
      pending_settlement_amount: 0,
      carry_amount: 0,
      orders_in_hand: 0,
      orders_sample: [],
      pending_extra_cost_approvals: 0,
    });
  });

  it.each([['abc'], ['12a'], [''], ['  '], [null], [undefined]])(
    'raqam bo`lmagan courier_id (%p) — 400, hech qanday so`rov yo`q',
    async (courierId) => {
      const { service, settlementRepo, orderRepo, dataSource } = makeService();

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: courierId as any }),
      );

      expect(err).toEqual({
        statusCode: 400,
        message: "courier_id raqam ko'rinishida bo'lishi kerak",
      });
      expect(settlementRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(orderRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    },
  );

  it('qo`lidagi buyurtmalar: is_deleted=false + Brackets (KURYER ushlovchi va yakunlanmagan) YOKI (courier_id va yo`lda/kutilmoqda)', async () => {
    const { service, orderQbs } = makeService({
      ordersInHand: 7,
      sample: [
        { id: '101', status: 'on the road' },
        { id: '102', status: 'cancelled' },
      ],
    });

    const res: any = await service.getCourierTransferCheck({
      courier_id: '263',
    });

    expect(orderQbs).toHaveLength(2);
    for (const qb of orderQbs) {
      expect(qb.where).toHaveBeenCalledWith('o.isDeleted = :isDeleted', {
        isDeleted: false,
      });
      const brackets = qb.andWhere.mock.calls[0][0] as Brackets;
      expect(brackets).toBeInstanceOf(Brackets);
      const inner: any = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };
      brackets.whereFactory(inner);
      expect(inner.where).toHaveBeenCalledWith(
        'o.holder_type = :courierHolder AND o.holder_courier_id = :courierId AND o.status NOT IN (:...doneStatuses)',
        {
          courierHolder: 'COURIER',
          courierId: '263',
          doneStatuses: [
            'sold',
            'paid',
            'partly_paid',
            'closed',
            'returned_to_market',
          ],
        },
      );
      expect(inner.orWhere).toHaveBeenCalledWith(
        'o.courier_id = :courierId AND o.status IN (:...actionableStatuses)',
        {
          courierId: '263',
          actionableStatuses: ['on the road', 'waiting', 'waiting_customer'],
        },
      );
    }

    // [0] — soni, [1] — namuna (id bo'yicha o'sib, ko'pi bilan 5 ta).
    expect(orderQbs[0].getCount).toHaveBeenCalledTimes(1);
    expect(orderQbs[1].select).toHaveBeenCalledWith('o.id', 'id');
    expect(orderQbs[1].addSelect).toHaveBeenCalledWith('o.status', 'status');
    expect(orderQbs[1].orderBy).toHaveBeenCalledWith('o.id', 'ASC');
    expect(orderQbs[1].limit).toHaveBeenCalledWith(5);

    expect(res.data.orders_in_hand).toBe(7);
    expect(res.data.orders_sample).toEqual([
      { id: '101', status: 'on the road' },
      { id: '102', status: 'cancelled' },
    ]);
  });

  it('PENDING savdo getCourierSettlementScope dan: soni va summasi = HQ + filial', async () => {
    const { service, scopeQb } = makeService({
      scopeRows: [
        { branch_id: null, count: '2', amount: '150000' },
        { branch_id: '15', count: '1', amount: '90000' },
      ],
    });

    const res: any = await service.getCourierTransferCheck({
      courier_id: '263',
    });

    expect(scopeQb.andWhere).toHaveBeenCalledWith(
      'settlement.courier_id = :courierId',
      { courierId: '263' },
    );
    expect(res.data).toEqual(
      expect.objectContaining({
        hq_pending_count: 2,
        hq_pending_amount: 150000,
        branch_pending_count: 1,
        branch_pending_amount: 90000,
        branch_ids: ['15'],
        pending_settlement_count: 3,
        pending_settlement_amount: 240000,
      }),
    );
  });

  describe("qoldiq (carry) — QAT'IY o'qiladi", () => {
    it('shu kuryerning courier_to_branch qoldig`i; boshqa kuryer va bo`g`in hisobga kirmaydi', async () => {
      const { service, carryRepo } = makeService({
        carries: [
          { level: 'courier_to_branch', party_id: '263', amount: 5000 },
          { level: 'courier_to_branch', party_id: '999', amount: 7000 },
          { level: 'branch_to_hq', party_id: '263', amount: 3000 },
        ],
      });

      const res: any = await service.getCourierTransferCheck({
        courier_id: '263',
      });

      expect(res.data.carry_amount).toBe(5000);
      expect(carryRepo.find).toHaveBeenCalledWith({
        where: {
          level: 'courier_to_branch',
          party_id: '263',
          isDeleted: false,
        },
      });
    });

    it('carry o`qish xatosi butun tekshiruvni yiqitadi (0 EMAS) — RpcException 500', async () => {
      const { service, carryRepo } = makeService();
      carryRepo.find.mockRejectedValue(new Error('connection reset'));

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: '263' }),
      );

      expect(err.statusCode).toBe(500);
    });

    it("jadval yo'q (to_regclass null) — 0, find chaqirilmaydi", async () => {
      const { service, dataSource, carryRepo } = makeService({
        carries: [
          { level: 'courier_to_branch', party_id: '263', amount: 5000 },
        ],
      });
      dataSource.query.mockResolvedValue([{ t: null }]);

      const res: any = await service.getCourierTransferCheck({
        courier_id: '263',
      });

      expect(res.data.carry_amount).toBe(0);
      expect(carryRepo.find).not.toHaveBeenCalled();
    });

    it("yutilgan xatodan qolgan `false` kesh qat'iy o'qishni aldamaydi", async () => {
      const { service, dataSource, carryRepo } = makeService({
        carries: [
          { level: 'courier_to_branch', party_id: '263', amount: 5000 },
        ],
      });
      // isCarryEnabled avval xatoni yutib "jadval yo'q" deb keshlagan.
      (service as any).carryTableReady = false;
      (service as any).carryCheckedAt = Date.now();

      const res: any = await service.getCourierTransferCheck({
        courier_id: '263',
      });

      // Yumshoq (wave-1) o'qish 60 s keshga ishonardi — qat'iysi jadvalni
      // qayta tekshiradi va haqiqiy qoldiqni ko'radi.
      expect(dataSource.query).toHaveBeenCalledWith(
        'SELECT to_regclass($1) AS t',
        ['order_schema.order_settlement_carry'],
      );
      expect(carryRepo.find).toHaveBeenCalledWith({
        where: {
          level: 'courier_to_branch',
          party_id: '263',
          isDeleted: false,
        },
      });
      expect(res.data.carry_amount).toBe(5000);
    });
  });

  it("ko'rib chiqilmagan qo'shimcha xarajat so'rovlari sanaladi", async () => {
    const { service, approvalRepo } = makeService({ approvals: 2 });

    const res: any = await service.getCourierTransferCheck({
      courier_id: '263',
    });

    expect(approvalRepo.count).toHaveBeenCalledWith({
      where: {
        requested_by_user_id: '263',
        status: 'pending',
        isDeleted: false,
      },
    });
    expect(res.data.pending_extra_cost_approvals).toBe(2);
  });

  describe('xatolar RpcException`ga o`raladi (RMQ qayta navbatga qo`ymasin)', () => {
    const queryFailed = (code: string) =>
      new QueryFailedError(
        'SELECT 1',
        [],
        Object.assign(new Error(`pg error ${code}`), { code }),
      );

    it('buyurtmalar so`rovi QueryFailedError — RpcException 500', async () => {
      const { service, orderRepo } = makeService();
      orderRepo.createQueryBuilder.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockRejectedValue(queryFailed('57014')),
        getRawMany: jest.fn().mockResolvedValue([]),
      }));

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: '263' }),
      );

      expect(err.statusCode).toBe(500);
      expect(err.message).toContain("Kuryer o'tkazish tekshiruvini");
    });

    it('getCourierSettlementScope dagi handleDbError xom qayta otgan xato ham o`raladi', async () => {
      const { service, scopeQb } = makeService();
      // 57014 (statement timeout) — handleDbError tanimaydi va xom qayta otadi.
      scopeQb.getRawMany.mockRejectedValue(queryFailed('57014'));

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: '263' }),
      );

      expect(err.statusCode).toBe(500);
    });

    it('handleDbError tanigan xato (22P02 → 400) o`zgarishsiz o`tadi', async () => {
      const { service, scopeQb } = makeService();
      scopeQb.getRawMany.mockRejectedValue(queryFailed('22P02'));

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: '263' }),
      );

      expect(err.statusCode).toBe(400);
    });

    it('qo`shimcha xarajat so`rovlari hisobi yiqilsa ham — RpcException 500', async () => {
      const { service, approvalRepo } = makeService();
      approvalRepo.count.mockRejectedValue(new Error('pool exhausted'));

      const err = await rpcErrorOf(
        service.getCourierTransferCheck({ courier_id: '263' }),
      );

      expect(err.statusCode).toBe(500);
    });
  });
});
