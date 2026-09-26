import { rmqSend } from '@app/common';
import { Brackets } from 'typeorm';
import {
  OrderServiceService,
  parseOrderNumberSearch,
} from './order-service.service';

/**
 * BUYURTMALAR QIDIRUVI — buyurtma raqami va mijozlar chegarasi.
 *
 * ⚠️ Ilgari qidiruv faqat mijoz ismi/telefoni bo'yicha ishlardi: buyurtma
 * raqamini (id) yozsa hech narsa topilmasdi. Mijozlar ro'yxati esa 1000 tada
 * JIMGINA kesilardi.
 */

jest.mock('@app/common', () => ({
  ...jest.requireActual<Record<string, unknown>>('@app/common'),
  rmqSend: jest.fn(),
}));

const rmqSendMock = rmqSend as unknown as jest.Mock;

type ListResult = {
  data: unknown[];
  total: number;
  search_truncated: boolean;
};

type Cond = { sql: string; params?: Record<string, unknown> };

function setup() {
  const conds: Cond[] = [];
  const bracketConds: Cond[] = [];
  const capture = (target: Cond[]) =>
    jest.fn((sql: unknown, params?: Record<string, unknown>) => {
      if (sql instanceof Brackets) {
        const sub = {
          where: capture(bracketConds),
          orWhere: capture(bracketConds),
          andWhere: capture(bracketConds),
        };
        sql.whereFactory(sub as never);
        target.push({ sql: '<brackets>' });
      } else {
        target.push({ sql: String(sql), params });
      }
      return qb;
    });
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: capture(conds),
    andWhere: capture(conds),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    clone: jest.fn(() => qb),
    getRawMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
  };
  const orderRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const custodyQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('SELECT 1'),
  };

  const service = new OrderServiceService(
    {} as any, // dataSource
    orderRepo as any, // orderRepo
    {} as any, // orderItemRepo
    {} as any, // orderTrackingRepo
    { createQueryBuilder: jest.fn().mockReturnValue(custodyQb) } as any, // orderCustodyEventRepo
    {} as any, // orderSettlementRepo
    {} as any, // transferBatchRepo
    {} as any, // transferBatchItemRepo
    {} as any, // transferBatchHistoryRepo
    {} as any, // searchClient
    {} as any, // identityClient
    {} as any, // logisticsClient
    {} as any, // catalogClient
    {} as any, // financeClient
    {} as any, // integrationClient
    {} as any, // branchClient
    {} as any, // fileClient
    {} as any, // outbox
    { log: jest.fn() } as any, // activityLog
    {} as any, // lookup
  );
  jest.spyOn(service as any, 'enrichOrders').mockResolvedValue([]);
  return { service, conds, bracketConds };
}

const customers = (count: number) => ({
  data: Array.from({ length: count }, (_, i) => ({ id: String(i + 1) })),
});

describe('parseOrderNumberSearch', () => {
  it('raqam -> buyurtma raqami', () => {
    expect(parseOrderNumberSearch('1251175')).toBe('1251175');
  });

  it.each([
    'Ali',
    '+998901234567',
    '12a',
    '#1251175',
    '1234567890123456789',
    '',
  ])('%p -> buyurtma raqami emas', (input) => {
    expect(parseOrderNumberSearch(input)).toBeNull();
  });
});

describe('findAllEnriched — qidiruv', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it("mijoz topilmasa ham buyurtma raqami bo'yicha qidiradi (1251175)", async () => {
    const { service, conds, bracketConds } = setup();
    rmqSendMock.mockResolvedValue({ data: [] });

    const res = (await service.findAllEnriched({
      search: '1251175',
      page: 1,
      limit: 10,
    })) as ListResult;

    // Ilgari mijoz topilmasa darhol bo'sh ro'yxat qaytardi.
    expect(conds.some((c) => c.sql === '<brackets>')).toBe(true);
    expect(bracketConds).toEqual([
      {
        sql: 'order.id = :search_order_id',
        params: { search_order_id: '1251175' },
      },
    ]);
    expect(res.search_truncated).toBe(false);
  });

  it('raqam telefon/ism bilan ham mos kelsa — buyurtma raqami YOKI mijozlar (OR)', async () => {
    const { service, bracketConds } = setup();
    rmqSendMock.mockResolvedValue(customers(2));

    await service.findAllEnriched({ search: '1251175', page: 1, limit: 10 });

    expect(bracketConds).toEqual([
      {
        sql: 'order.id = :search_order_id',
        params: { search_order_id: '1251175' },
      },
      {
        sql: 'order.customer_id IN (:...customer_ids)',
        params: { customer_ids: ['1', '2'] },
      },
    ]);
  });

  it("matnli qidiruv (ism) avvalgidek faqat mijozlar bo'yicha", async () => {
    const { service, conds } = setup();
    rmqSendMock.mockResolvedValue(customers(2));

    await service.findAllEnriched({
      search: 'Ali',
      status: 'waiting',
      page: 1,
      limit: 10,
    });

    expect(conds).toContainEqual({
      sql: 'order.customer_id IN (:...customer_ids)',
      params: { customer_ids: ['1', '2'] },
    });
    expect(
      conds.some(
        (c) => c.sql === '<brackets>' || c.sql.includes('search_order_id'),
      ),
    ).toBe(false);
  });

  it("matnli qidiruvda mijoz topilmasa bo'sh ro'yxat (regressiya)", async () => {
    const { service, conds } = setup();
    rmqSendMock.mockResolvedValue({ data: [] });

    const res = (await service.findAllEnriched({
      search: "Yo'qmijoz",
      page: 1,
      limit: 10,
    })) as ListResult;

    expect(res.total).toBe(0);
    expect(res.data).toEqual([]);
    expect(conds).toEqual([]);
  });

  it('1000 dan ortiq mijoz mos kelsa search_truncated=true va 1000 tasi ishlatiladi', async () => {
    const { service, conds } = setup();
    rmqSendMock.mockResolvedValue(customers(1001));

    const res = (await service.findAllEnriched({
      search: 'ali',
      page: 1,
      limit: 10,
    })) as ListResult;

    expect((rmqSendMock.mock.calls[0] as unknown[])[2]).toEqual({
      search: 'ali',
      limit: 1001,
    });
    expect(res.search_truncated).toBe(true);
    const used = conds.find((c) => c.params && 'customer_ids' in c.params)
      ?.params?.customer_ids as string[] | undefined;
    expect(used).toHaveLength(1000);
  });

  it('aynan 1000 ta mijozda search_truncated=false', async () => {
    const { service } = setup();
    rmqSendMock.mockResolvedValue(customers(1000));

    const res = (await service.findAllEnriched({
      search: 'ali',
      page: 1,
      limit: 10,
    })) as ListResult;

    expect(res.search_truncated).toBe(false);
  });

  it("qidiruvsiz so'rov identity'ga murojaat qilmaydi va ro'yxat to'liq qaytadi", async () => {
    const { service, conds } = setup();

    const res = (await service.findAllEnriched({
      page: 1,
      limit: 10,
    })) as ListResult;

    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(
      conds.some(
        (c) => c.sql.includes('customer_id') || c.sql === '<brackets>',
      ),
    ).toBe(false);
    expect(res.search_truncated).toBe(false);
  });
});
