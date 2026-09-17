import { IntegrationServiceService } from './integration-service.service';

/**
 * JO'NATMALAR RO'YXATI.
 *
 * Ro'yxat "qaysi posilka yetmadi?" degan savolga javob beradi — shu bois
 * filtrlar to'g'ri ishlashi MUHIM. Ular buzilsa ekran jimgina noto'g'ri
 * to'da ko'rsatadi: xato bermaydi, faqat yiqilgan posilkalar ro'yxatdan
 * tushib qoladi va ularni hech kim qayta jo'natmaydi.
 */

type Cond = { sql: string; params?: Record<string, unknown> };

function setup(rows: unknown[] = [], total = 0) {
  const conds: Cond[] = [];
  const qb: Record<string, jest.Mock> = {
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
  };

  const shipmentRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const partnerRefRepo = {
    findAndCount: jest.fn().mockResolvedValue([rows, total]),
  };

  /**
   * Konstruktor juda ko'p bog'liqlikka ega; bu testga faqat ikkita repo
   * kerak. Qolganini `{}` bilan beramiz — metodlar ularga tegmaydi.
   */
  const service = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService;
  Object.assign(service, {
    shipmentRepo,
    partnerShipmentRefRepo: partnerRefRepo,
  });

  return { service, qb, conds, partnerRefRepo };
}

const has = (conds: Cond[], needle: string) =>
  conds.some((c) => c.sql.includes(needle));

describe('listProviderShipments', () => {
  it('ulanish bo‘yicha filtrlaydi', async () => {
    const { service, conds } = setup();
    await service.listProviderShipments({ integration_id: '7' });
    expect(has(conds, 's.integration_id')).toBe(true);
  });

  it("o'chirilgan yozuvlar chiqmaydi", async () => {
    const { service, conds } = setup();
    await service.listProviderShipments({});
    expect(has(conds, 's.isDeleted')).toBe(true);
  });

  it('⭐ status filtri ICHKI status bo‘yicha', async () => {
    /**
     * Tashuvchining o'z statusi har provayderda boshqacha nomlanadi
     * (`delivered`, `DELIVERED`, `success`...). Ro'yxatni filtrlash uchun
     * faqat ichki status yaroqli.
     */
    const { service, conds } = setup();
    await service.listProviderShipments({ status: 'sold' });
    expect(has(conds, 's.internal_status')).toBe(true);
    expect(has(conds, 's.provider_status')).toBe(false);
  });

  it('⭐ `failed_only` xato MATNI bor qatorlarni tanlaydi', async () => {
    // "Yiqilgan" ning yagona ishonchli belgisi — `last_error` to'ldirilgani.
    const { service, conds } = setup();
    await service.listProviderShipments({ failed_only: true });
    expect(has(conds, 's.last_error IS NOT NULL')).toBe(true);
  });

  it('`failed_only` berilmasa xato filtri QO‘YILMAYDI', async () => {
    const { service, conds } = setup();
    await service.listProviderShipments({});
    expect(has(conds, 'last_error')).toBe(false);
  });

  it('⭐ limit 100 dan oshmaydi (bir so‘rovda butun jadval tortilmasin)', async () => {
    const { service, qb } = setup();
    await service.listProviderShipments({ limit: 5000 });
    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it('sahifalash hisoblanadi', async () => {
    const { service, qb } = setup();
    await service.listProviderShipments({ page: 3, limit: 20 });
    expect(qb.skip).toHaveBeenCalledWith(40);
    expect(qb.take).toHaveBeenCalledWith(20);
  });

  it("noto'g'ri sahifa/limit xavfsiz sukutga tushadi", async () => {
    const { service, qb } = setup();
    await service.listProviderShipments({ page: -5, limit: 0 });
    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
  });

  it('javobda sahifalash maʼlumoti bor', async () => {
    const { service } = setup([{ id: '1' }], 41);
    const res = (await service.listProviderShipments({ limit: 20 })) as {
      data: { pagination: { total: number; totalPages: number } };
    };
    expect(res.data.pagination.total).toBe(41);
    expect(res.data.pagination.totalPages).toBe(3);
  });
});

describe('listPartnerShipments', () => {
  it('hamkor bo‘yicha filtrlaydi va oʻchirilganni chiqarmaydi', async () => {
    const { service, partnerRefRepo } = setup();
    await service.listPartnerShipments({ partner_id: '9' });
    const arg = partnerRefRepo.findAndCount.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.partner_id).toBe('9');
    expect(arg.where.isDeleted).toBe(false);
  });

  it('⭐ limit 100 dan oshmaydi', async () => {
    const { service, partnerRefRepo } = setup();
    await service.listPartnerShipments({ limit: 9999 });
    const arg = partnerRefRepo.findAndCount.mock.calls[0][0] as {
      take: number;
    };
    expect(arg.take).toBe(100);
  });

  it('yangi yozuv yuqorida', async () => {
    const { service, partnerRefRepo } = setup();
    await service.listPartnerShipments({});
    const arg = partnerRefRepo.findAndCount.mock.calls[0][0] as {
      order: Record<string, string>;
    };
    expect(arg.order.createdAt).toBe('DESC');
  });
});
