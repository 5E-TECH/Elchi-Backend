import { RpcException } from '@nestjs/microservices';
import {
  OrderServiceService,
  parseOrderListSort,
} from './order-service.service';

/**
 * GET /orders SERVER TOMONIDA SARALASH.
 *
 * ⚠️ Ilgari ro'yxat doim `createdAt DESC` edi — frontend faqat ochilgan sahifa
 * ichida saralardi va 2-sahifadagi eng qimmat buyurtma 1-sahifaga chiqmasdi.
 * SQL tartibi haqiqiy Postgres'da (25 buyurtma, 3 sahifa, join bilan) alohida
 * tekshirilgan; bu yerda kalitlar oq ro'yxati va qurilgan ORDER BY qulflanadi.
 */

type OrderByCall = [string, string];

function setup() {
  const orderBys: OrderByCall[] = [];
  const addSelects: Array<[string, string]> = [];
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn((sql: string, alias: string) => {
      addSelects.push([sql, alias]);
      return qb;
    }),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn((key: string, dir: string) => {
      orderBys.length = 0;
      orderBys.push([key, dir]);
      return qb;
    }),
    addOrderBy: jest.fn((key: string, dir: string) => {
      orderBys.push([key, dir]);
      return qb;
    }),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    clone: jest.fn(() => qb),
    getMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
  };
  const orderRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const stub = {} as never;
  const service = new OrderServiceService(
    stub, // dataSource
    orderRepo as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    { log: jest.fn() } as never, // activityLog
    stub,
  );
  return { service, qb, orderBys, addSelects };
}

describe('parseOrderListSort', () => {
  it('parametrsiz — null (avvalgi tartib)', () => {
    expect(parseOrderListSort()).toBeNull();
    expect(parseOrderListSort('', '')).toBeNull();
  });

  it.each([
    ['total_price', 'desc', { field: 'total_price', dir: 'DESC' }],
    ['created_at', 'asc', { field: 'created_at', dir: 'ASC' }],
    ['status', 'asc', { field: 'status', dir: 'ASC' }],
    ['total_price', undefined, { field: 'total_price', dir: 'DESC' }],
  ])('%p %p -> %p', (by, dir, expected) => {
    expect(parseOrderListSort(by, dir)).toEqual(expected);
  });

  it.each([
    ['price; DROP TABLE orders', 'asc'],
    ['order.createdAt', 'desc'],
    ['customer', 'asc'],
    ['total_price', 'sideways'],
    ['', 'asc'],
  ])('%p %p -> 400 (SQL ga tushmaydi)', (by, dir) => {
    expect(() => parseOrderListSort(by, dir)).toThrow(RpcException);
    try {
      parseOrderListSort(by, dir);
    } catch (error) {
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 400,
      });
    }
  });
});

describe('findAll — ORDER BY', () => {
  it("parametrsiz so'rov avvalgidek createdAt DESC", async () => {
    const { service, orderBys, addSelects } = setup();

    await service.findAll({ page: 1, limit: 10 });

    expect(orderBys).toEqual([['order.createdAt', 'DESC']]);
    expect(addSelects).toEqual([]);
  });

  it("total_price desc — butun ro'yxat bo'yicha, ikkinchi kalit id", async () => {
    const { service, orderBys } = setup();

    await service.findAll({ sort_by: 'total_price', sort_dir: 'desc' });

    expect(orderBys).toEqual([
      ['order.total_price', 'DESC'],
      ['order.id', 'DESC'],
    ]);
  });

  it('created_at asc — eng eskisi birinchi, ikkinchi kalit id', async () => {
    const { service, orderBys } = setup();

    await service.findAll({ sort_by: 'created_at', sort_dir: 'asc' });

    expect(orderBys).toEqual([
      ['order.createdAt', 'ASC'],
      ['order.id', 'ASC'],
    ]);
  });

  it('status — hayot tsikli tartibi (alifbo emas), alias orqali', async () => {
    const { service, orderBys, addSelects } = setup();

    await service.findAll({ sort_by: 'status', sort_dir: 'asc' });

    expect(addSelects).toHaveLength(1);
    const [sql, alias] = addSelects[0];
    expect(orderBys).toEqual([
      [alias, 'ASC'],
      ['order.id', 'ASC'],
    ]);
    // Frontenddagi ORDER_STATUS_RANK bilan bir xil tartib.
    const lifecycle = [
      'created',
      'new',
      'received',
      'on the road',
      'waiting',
      'sold',
      'paid',
      'partly_paid',
      'closed',
      'cancelled',
      'cancelled (sent)',
    ];
    lifecycle.forEach((status, rank) => {
      expect(sql).toContain(`WHEN '${status}' THEN ${rank}`);
    });
    expect(sql).toContain(`ELSE ${lifecycle.length} END`);
  });

  it("noto'g'ri sort_by bazaga so'rov yubormaydi", async () => {
    const { service, qb } = setup();

    await expect(
      service.findAll({ sort_by: 'total_price desc, (select 1)' }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(qb.getMany).not.toHaveBeenCalled();
  });
});
