import { Order_status } from '@app/common';
// `Order_source` `@app/common` da EMAS — u order entity'sida e'lon qilingan.
import { Order_source } from './entities/order.entity';
import { OrderServiceService } from './order-service.service';

/**
 * KIRUVCHI POSILKA MANBALARI.
 *
 * Ekran ilgari BARCHA tashqi buyurtmani bitta ro'yxatda ko'rsatardi. Bu test
 * guruhlash shartlarini qulflaydi, chunki ularning har biri buzilganda ekran
 * JIMGINA noto'g'ri son ko'rsatadi — xato bermaydi, faqat yolg'on aytadi.
 */

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

const { rmqSend } = require('@app/common') as { rmqSend: jest.Mock };

type Cond = { sql: string; params?: Record<string, unknown> };

function setup(rows: Array<Record<string, unknown>> = []) {
  const conds: Cond[] = [];
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };

  const orderRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

  // 16 pozitsion bog'liqlik — faqat `orderRepo` ishlatiladi.
  const service = new OrderServiceService(
    {} as any,
    orderRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { log: jest.fn() } as any,
    {} as any,
  );

  return { service, qb, conds };
}

const has = (conds: Cond[], needle: string) =>
  conds.some((c) => c.sql.includes(needle));

const paramOf = (conds: Cond[], key: string) => {
  for (const c of conds) {
    if (c.params && key in c.params) return c.params[key];
  }
  return undefined;
};

describe('findExternalSources — guruhlash shartlari', () => {
  beforeEach(() => rmqSend.mockReset());

  it('⭐ FAQAT tashqi manbali buyurtmalar sanaladi', async () => {
    // Bu shart tushib qolsa, ichki buyurtmalar ham "kiruvchi posilka" bo'lardi.
    const { service, conds } = setup();
    await service.findExternalSources();
    expect(has(conds, 'order.source')).toBe(true);
    expect(paramOf(conds, 'source')).toBe(Order_source.EXTERNAL);
  });

  it("⭐ faqat NEW holat — qabul qilingani qayta ko'rinmasin", async () => {
    const { service, conds } = setup();
    await service.findExternalSources();
    expect(paramOf(conds, 'status')).toBe(Order_status.NEW);
  });

  it("⭐ pochtaga qo'shilgan posilka sanalmaydi", async () => {
    /**
     * `markets/new` ekrani ham ayni shartni qo'yadi. Bu yerda tushib qolsa,
     * ikki ekran boshqa-boshqa son ko'rsatib, qaysi biri to'g'riligini
     * aniqlash mumkin bo'lmasdi.
     */
    const { service, conds } = setup();
    await service.findExternalSources();
    expect(has(conds, 'current_batch_id IS NULL')).toBe(true);
  });

  it("o'chirilgan buyurtma sanalmaydi", async () => {
    const { service, conds } = setup();
    await service.findExternalSources();
    expect(paramOf(conds, 'isDeleted')).toBe(false);
  });

  it("⭐ filial berilsa doira qo'yiladi, berilmasa qo'yilmaydi", async () => {
    /**
     * Doira MUHIM: `order.receive` begona filial buyurtmasi bo'lsa BUTUN
     * so'rovni rad etadi. Doirasiz sanalgan son menejerga "12 posilka bor"
     * deb ko'rsatib, qabulda to'liq xato berardi.
     */
    const scoped = setup();
    await scoped.service.findExternalSources('branch-7');
    expect(paramOf(scoped.conds, 'branch_id')).toBe('branch-7');

    const open = setup();
    await open.service.findExternalSources();
    expect(has(open.conds, 'order.branch_id')).toBe(false);
  });

  it('sonlar songa aylantiriladi (SQL matn qaytaradi)', async () => {
    const { service } = setup([
      {
        market_id: '5',
        orders_count: '12',
        total_price_sum: '1500000',
        oldest_at: new Date('2026-09-01T10:00:00Z'),
      },
    ]);
    const rows = await service.findExternalSources();
    expect(rows[0].orders_count).toBe(12);
    expect(rows[0].total_price_sum).toBe(1_500_000);
    expect(rows[0].oldest_at).toBe('2026-09-01T10:00:00.000Z');
  });

  it("oldest_at bo'sh bo'lsa null qoladi", async () => {
    const { service } = setup([
      {
        market_id: '5',
        orders_count: '1',
        total_price_sum: '0',
        oldest_at: null,
      },
    ]);
    const rows = await service.findExternalSources();
    expect(rows[0].oldest_at).toBeNull();
  });
});

describe("findExternalSourcesEnriched — nom qo'shish", () => {
  beforeEach(() => rmqSend.mockReset());

  it('market nomi qator bilan birga qaytadi', async () => {
    const { service } = setup([
      {
        market_id: '5',
        orders_count: '2',
        total_price_sum: '0',
        oldest_at: null,
      },
    ]);
    rmqSend.mockResolvedValue({ data: [{ id: '5', name: 'Beepost' }] });

    const rows = (await service.findExternalSourcesEnriched()) as Array<
      Record<string, any>
    >;
    expect(rows[0].market.name).toBe('Beepost');
  });

  it('⭐ nom topilmasa ham qator TUSHIB QOLMAYDI', async () => {
    /**
     * Posilkalar haqiqatan kutib turadi. Nomi yechilmagani uchun qatorni
     * yashirish qabul qilishni imkonsiz qilardi va sababi ko'rinmasdi.
     */
    const { service } = setup([
      {
        market_id: '9',
        orders_count: '3',
        total_price_sum: '0',
        oldest_at: null,
      },
    ]);
    rmqSend.mockResolvedValue({ data: [] });

    const rows = (await service.findExternalSourcesEnriched()) as Array<
      Record<string, any>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].market).toBeNull();
    expect(rows[0].orders_count).toBe(3);
  });

  it("⭐ identity xizmati yiqilsa ham ro'yxat qaytadi", async () => {
    // Nom — qulaylik, posilka ro'yxati esa ISH. Ikkinchisi birinchisiga
    // bog'liq bo'lib qolmasligi kerak.
    const { service } = setup([
      {
        market_id: '9',
        orders_count: '3',
        total_price_sum: '0',
        oldest_at: null,
      },
    ]);
    rmqSend.mockRejectedValue(new Error('rmq down'));

    const rows = (await service.findExternalSourcesEnriched()) as Array<
      Record<string, any>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].market).toBeNull();
  });

  it("manba bo'lmasa bo'sh ro'yxat, identity CHAQIRILMAYDI", async () => {
    const { service } = setup([]);
    const rows = await service.findExternalSourcesEnriched();
    expect(rows).toEqual([]);
    expect(rmqSend).not.toHaveBeenCalled();
  });
});
