import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { DeliveryPricingService } from './delivery-pricing.service';
import type { DeliveryQuotePayload } from './delivery-pricing.types';

/**
 * DAqXPeSy — logistics `DeliveryPricingService` (DB'siz, soxta repo'lar):
 * tarif tanlash (`is_city_zone`), tuman → geografik viloyat, catalog'dan
 * o'lchov, MARKET egaligi, xatolar va admin validatsiyasi. Haqiqiy SQL
 * (faol versiya, migratsiya, tranzaksiya) — `delivery-pricing.pg.spec.ts`.
 */

const REGIONS: Record<
  string,
  { id: string; name: string; is_city_zone: boolean }
> = {
  '1': { id: '1', name: 'Toshkent shahri', is_city_zone: true },
  '2': { id: '2', name: 'Toshkent', is_city_zone: false }, // viloyat (SOATO 1727)
  '6': { id: '6', name: 'Samarqand', is_city_zone: false },
};
const DISTRICTS: Record<
  string,
  { id: string; region_id: string; assigned_region: string | null }
> = {
  // Chilonzor — Toshkent shahri
  '10': { id: '10', region_id: '1', assigned_region: null },
  // Zangiota — Toshkent viloyati, lekin shahar filialiga biriktirilgan
  '20': { id: '20', region_id: '2', assigned_region: '1' },
  // Samarqand tumani
  '60': { id: '60', region_id: '6', assigned_region: null },
};

const TARIFFS: Record<string, Record<string, unknown>> = {
  city: {
    id: '1',
    tariff_id: 'city',
    base_price: 35000,
    extra_per_kg: 4000,
    days_min: 1,
    days_max: 1,
    valid_from: new Date('2026-10-08'),
  },
  center: {
    id: '2',
    tariff_id: 'center',
    base_price: 40000,
    extra_per_kg: 4000,
    days_min: 1,
    days_max: 2,
    valid_from: new Date('2026-10-08'),
  },
  address: {
    id: '3',
    tariff_id: 'address',
    base_price: 60000,
    extra_per_kg: 5000,
    days_min: 2,
    days_max: 3,
    valid_from: new Date('2026-10-08'),
  },
};
const SETTINGS = {
  id: '1',
  volumetric_divisor: 5000,
  first_kg_included: 1,
  min_billable_kg: 0.1,
  billable_step_kg: 0.1,
  round_to: 500,
  pickup_fee: 20000,
  pickup_free_from_count: 10,
  express_multiplier: 1.4,
  is_active: true,
};

const PRODUCTS = [
  {
    id: '42',
    user_id: '501',
    weight_kg: 1.2,
    length_cm: 30,
    width_cm: 22,
    height_cm: 15,
    volumetric_enabled: true,
  },
  {
    id: '43',
    user_id: '501',
    weight_kg: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    volumetric_enabled: true,
  },
  {
    id: '44',
    user_id: '777',
    weight_kg: 2,
    length_cm: 60,
    width_cm: 40,
    height_cm: 30,
    volumetric_enabled: false,
  },
];

function build(
  options: {
    catalogFails?: boolean;
    noTariff?: boolean;
    noSettings?: boolean;
  } = {},
) {
  const regionRepo = {
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(REGIONS[id] ?? null),
    ),
  };
  const districtRepo = {
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(DISTRICTS[id] ?? null),
    ),
  };
  const saved: Record<string, unknown>[] = [];
  const tariffRepo = {
    manager: {},
    create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
    save: jest.fn((row: Record<string, unknown>) => {
      const withId = { id: '99', valid_from: new Date(), ...row };
      saved.push(withId);
      return Promise.resolve(withId);
    }),
    findOne: jest.fn(() => Promise.resolve(saved[saved.length - 1] ?? null)),
  };
  const settingsRepo = {
    manager: { transaction: jest.fn() },
    find: jest.fn(() => Promise.resolve([SETTINGS])),
  };
  const catalogClient = {
    send: jest.fn((_pattern: { cmd: string }, payload: { ids: string[] }) =>
      options.catalogFails
        ? throwError(() => new Error('catalog down'))
        : of({ data: PRODUCTS.filter((p) => payload.ids.includes(p.id)) }),
    ),
  };
  const activityLog = { log: jest.fn(), logChange: jest.fn() };
  const service = new DeliveryPricingService(
    tariffRepo as never,
    settingsRepo as never,
    regionRepo as never,
    districtRepo as never,
    catalogClient as never,
    activityLog as never,
  );
  jest
    .spyOn(service, 'findCurrentTariff')
    .mockImplementation((id: string) =>
      Promise.resolve(
        options.noTariff ? null : ((TARIFFS[id] as never) ?? null),
      ),
    );
  jest
    .spyOn(service, 'findActiveSettings')
    .mockImplementation(() =>
      Promise.resolve(options.noSettings ? null : (SETTINGS as never)),
    );
  return { service, catalogClient, activityLog, tariffRepo, settingsRepo };
}

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
      data?: unknown;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

const ITEM = { weight_kg: 1.2, length_cm: 30, width_cm: 22, height_cm: 15 };
const quoteOf = async (
  service: DeliveryPricingService,
  payload: Partial<DeliveryQuotePayload>,
) =>
  (
    (await service.quote({
      items: [ITEM],
      where_deliver: 'center',
      ...payload,
    } as DeliveryQuotePayload)) as { data: Record<string, any> }
  ).data;

describe('DAqXPeSy — tarif tanlash (is_city_zone)', () => {
  it('ikkala uchi ham Toshkent shahri → city (where_deliver e`tiborsiz)', async () => {
    const { service } = build();
    for (const where_deliver of ['center', 'address']) {
      const q = await quoteOf(service, {
        from_region_id: '1',
        to_district_id: '10',
        where_deliver,
      });
      expect(q.tariffId).toBe('city');
      expect(q.route).toEqual({
        from_region_id: '1',
        to_region_id: '1',
        city_route: true,
        where_deliver,
      });
      expect(q.total).toBe(39000); // 35 000 + 1 × 4 000 (2.0 kg)
    }
  });

  it('Toshkent shahri → Toshkent VILOYATI — center/address (shahar emas)', async () => {
    const { service } = build();
    const center = await quoteOf(service, {
      from_region_id: '1',
      to_region_id: '2',
    });
    const address = await quoteOf(service, {
      from_region_id: '1',
      to_region_id: '2',
      where_deliver: 'address',
    });
    expect(center.tariffId).toBe('center');
    expect(center.total).toBe(44000);
    expect(address.tariffId).toBe('address');
    expect(address.total).toBe(65000);
  });

  it('tuman GEOGRAFIK viloyatidan: viloyat tumani shahar filialiga biriktirilgan bo`lsa ham — center', async () => {
    const { service } = build();
    const q = await quoteOf(service, {
      from_district_id: '10',
      to_district_id: '20',
    });
    expect(q.route.to_region_id).toBe('2');
    expect(q.tariffId).toBe('center');
  });

  it('boshqa viloyat → where_deliver; javobda tarif versiyasi va sozlama id', async () => {
    const { service } = build();
    const q = await quoteOf(service, {
      from_region_id: '1',
      to_district_id: '60',
      where_deliver: 'address',
    });
    expect(q.tariffId).toBe('address');
    expect(q.tariff).toMatchObject({
      id: '3',
      tariff_id: 'address',
      base_price: 60000,
    });
    expect(q.settings_id).toBe('1');
    expect(q.daysMin).toBe(2);
    expect(q.daysMax).toBe(3);
  });
});

describe('DAqXPeSy — mahsulotlar catalog`dan', () => {
  it('product_id → o`lchov catalog`dan; o`lchovsiz mahsulot ro`yxatda, narx 0 emas', async () => {
    const { service, catalogClient } = build();
    const q = await quoteOf(service, {
      from_region_id: '1',
      to_region_id: '6',
      items: [
        { product_id: '42', quantity: 2 },
        { product_id: '43' },
        { weight_kg: 0.5 },
      ],
      requester: { id: '501', roles: ['market'] },
    });
    expect(catalogClient.send).toHaveBeenCalledTimes(1);
    expect(catalogClient.send.mock.calls[0][0]).toEqual({
      cmd: 'catalog.product.find_by_ids',
    });
    expect(catalogClient.send.mock.calls[0][1]).toEqual({ ids: ['42', '43'] });
    // 2 × 1.2 + 0.5 = 2.9 kg; hajm 2 × 9 900 / 5000 = 3.96 → 4.0 kg
    expect(q.actualKg).toBe(2.9);
    expect(q.billableKg).toBe(4);
    expect(q.unmeasuredItems).toBe(1);
    expect(q.estimated).toBe(true);
    expect(q.unmeasured_product_ids).toEqual(['43']);
    expect(q.missing_dimension_product_ids).toEqual(['43']);
    expect(q.total).toBe(52000);
  });

  it('volumetric_enabled = false mahsulot (catalog) — hajmi kirmaydi', async () => {
    const { service } = build();
    const q = await quoteOf(service, {
      from_region_id: '1',
      to_region_id: '6',
      items: [{ product_id: '44' }],
      requester: { id: '1', roles: ['admin'] },
    });
    expect(q.volumetricKg).toBe(0);
    expect(q.billableKg).toBe(2);
    expect(q.total).toBe(44000);
  });

  it('MARKET — begona mahsulot 404 (mavjudligi oshkor qilinmaydi)', async () => {
    const { service } = build();
    const err = await rpcError(
      service.quote({
        items: [{ product_id: '44' }],
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
        requester: { id: '501', roles: ['market'] },
      }),
    );
    expect(err.statusCode).toBe(404);
    expect(err.data).toEqual({ product_ids: ['44'] });
  });

  it('xodim — har qanday market mahsuloti; yo`q mahsulot — 404', async () => {
    const { service } = build();
    const err = await rpcError(
      service.quote({
        items: [{ product_id: '42' }, { product_id: '999' }],
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
        requester: { id: '1', roles: ['superadmin'] },
      }),
    );
    expect(err.statusCode).toBe(404);
    expect(err.data).toEqual({ product_ids: ['999'] });
  });

  it('catalog javob bermasa — 503 (jim 0 emas)', async () => {
    const { service } = build({ catalogFails: true });
    const err = await rpcError(
      service.quote({
        items: [{ product_id: '42' }],
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
      }),
    );
    expect(err.statusCode).toBe(503);
  });
});

describe('DAqXPeSy — quote xatolari', () => {
  it.each<[string, Partial<DeliveryQuotePayload>, number]>([
    ['where_deliver yo`q', { where_deliver: '' }, 400],
    ['items bo`sh', { items: [] }, 400],
    ['from yo`q', { from_region_id: undefined, to_region_id: '6' }, 400],
    ['to yo`q', { from_region_id: '1', to_region_id: undefined }, 400],
    ['region id raqam emas', { from_region_id: 'x', to_region_id: '6' }, 400],
    [
      'tuman viloyatga mos emas',
      { from_region_id: '1', to_region_id: '6', to_district_id: '10' },
      400,
    ],
    ['viloyat topilmadi', { from_region_id: '1', to_region_id: '404' }, 404],
    ['tuman topilmadi', { from_region_id: '1', to_district_id: '404' }, 404],
    [
      'product_id bilan o`lchov',
      {
        from_region_id: '1',
        to_region_id: '6',
        items: [{ product_id: '42', weight_kg: 0.1 }],
      },
      400,
    ],
    [
      'manfiy og`irlik (RMQ yo`li)',
      { from_region_id: '1', to_region_id: '6', items: [{ weight_kg: -2 }] },
      400,
    ],
  ])('%s → %i', async (_name, payload, code) => {
    const { service } = build();
    const err = await rpcError(
      service.quote({
        items: [ITEM],
        where_deliver: 'center',
        ...payload,
      } as DeliveryQuotePayload),
    );
    expect(err.statusCode).toBe(code);
  });

  it('faol tarif yo`q — 409', async () => {
    const { service } = build({ noTariff: true });
    const err = await rpcError(
      service.quote({
        items: [ITEM],
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
      }),
    );
    expect(err.statusCode).toBe(409);
  });

  it('faol sozlama yo`q — 409', async () => {
    const { service } = build({ noSettings: true });
    const err = await rpcError(
      service.quote({
        items: [ITEM],
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
      }),
    );
    expect(err.statusCode).toBe(409);
  });
});

describe('DAqXPeSy — admin: yangi tarif versiyasi', () => {
  const VALID = {
    tariff_id: 'center',
    base_price: 42000,
    extra_per_kg: 4500,
    days_min: 1,
    days_max: 2,
  };

  it('yangi qator yoziladi (eski o`zgarmaydi) va activity-log`ga tushadi', async () => {
    const { service, tariffRepo, activityLog } = build();
    const res = (await service.createTariff(VALID, {
      id: '1',
      roles: ['superadmin'],
    })) as { statusCode: number; data: Record<string, unknown> };
    expect(res.statusCode).toBe(201);
    expect(tariffRepo.save).toHaveBeenCalledTimes(1);
    expect(tariffRepo.save.mock.calls[0][0]).toMatchObject({
      tariff_id: 'center',
      base_price: 42000,
      extra_per_kg: 4500,
      is_active: true,
      created_by: '1',
    });
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log.mock.calls[0][0]).toMatchObject({
      entity_type: 'DeliveryTariff',
      entity_id: '99',
      action: 'logistics.delivery_tariff_created',
      old_value: { id: '2', base_price: 40000, extra_per_kg: 4000 },
      new_value: { tariff_id: 'center', base_price: 42000, extra_per_kg: 4500 },
      user_id: '1',
      user_role: 'superadmin',
      description:
        "Yetkazish tarifi «center» — yangi versiya: 42 000 so'm + 4 500 so'm/kg",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['tariff_id noto`g`ri', { tariff_id: 'express' }],
    ['base_price manfiy', { base_price: -1 }],
    ['extra_per_kg 3 kasr', { extra_per_kg: 1.005 }],
    ['days_max < days_min', { days_min: 3, days_max: 2 }],
    ['days kasr', { days_min: 1.5 }],
    ['valid_from noto`g`ri', { valid_from: 'ertaga' }],
    ['valid_from o`tmishda', { valid_from: '2020-01-01T00:00:00Z' }],
  ])('400 — %s', async (_name, patch) => {
    const { service, tariffRepo, activityLog } = build();
    const err = await rpcError(
      service.createTariff({ ...VALID, ...patch } as never, { id: '1' }),
    );
    expect(err.statusCode).toBe(400);
    expect(tariffRepo.save).not.toHaveBeenCalled();
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('kelajak valid_from — ruxsat (rejalashtirilgan versiya)', async () => {
    const { service, tariffRepo } = build();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await service.createTariff({ ...VALID, valid_from: future }, { id: '1' });
    expect(
      (
        tariffRepo.save.mock.calls[0][0] as { valid_from: Date }
      ).valid_from.toISOString(),
    ).toBe(future);
  });
});

describe('DAqXPeSy — admin: sozlamalar validatsiyasi (tranzaksiyadan OLDIN)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['bo`sh patch', {}],
    ['volumetric_divisor 0', { volumetric_divisor: 0 }],
    ['round_to kasr', { round_to: 500.5 }],
    ['express_multiplier < 1', { express_multiplier: 0.5 }],
    ['min_billable_kg null', { min_billable_kg: null }],
    ['pickup_fee satr', { pickup_fee: '20000' }],
    ['pickup_free_from_count 0', { pickup_free_from_count: 0 }],
  ])('400 — %s', async (_name, dto) => {
    const { service } = build();
    const err = await rpcError(
      service.updateSettings(dto as never, { id: '1' }),
    );
    expect(err.statusCode).toBe(400);
  });
});

describe('6FLyjO6j — quote_by_tariff (hududsiz, uchala tarif)', () => {
  const byTariff = async (
    service: DeliveryPricingService,
    items: Record<string, unknown>[],
  ) =>
    (
      (await service.quoteByTariff({ items } as never)) as {
        data: { quotes: Record<string, any>; unmeasured_product_ids: string[] };
      }
    ).data;

  it('30×22×15 / 1,2 kg → city 39 000, center 44 000, address 65 000 (landing)', async () => {
    const { service } = build();
    const { quotes } = await byTariff(service, [ITEM]);
    expect(quotes.city.total).toBe(39000);
    expect(quotes.center.total).toBe(44000);
    expect(quotes.address.total).toBe(65000);
    expect(quotes.center.billableKg).toBe(2);
    expect(quotes.center.tariff.tariff_id).toBe('center');
  });

  it("faol tarif yo'q bo'lsa — shu tarif null, so'rov yiqilmaydi", async () => {
    const { service } = build({ noTariff: true });
    const { quotes } = await byTariff(service, [ITEM]);
    expect(quotes).toEqual({ city: null, center: null, address: null });
  });

  it("bo'sh items → 400", async () => {
    const { service } = build();
    const err = await rpcError(service.quoteByTariff({ items: [] } as never));
    expect(err.statusCode).toBe(400);
  });
});

describe('47WFHzlx — sozlamalar tarixi', () => {
  it('barcha versiyalar, yangisi tepada; limit 500 bilan cheklanadi', async () => {
    const { service, settingsRepo } = build();
    const res = (await service.listSettingsHistory({ limit: 9999 })) as {
      data: { versions: unknown[] };
    };
    expect(res.data.versions).toEqual([SETTINGS]);
    expect(settingsRepo.find).toHaveBeenCalledWith({
      where: { isDeleted: false },
      order: { id: 'DESC' },
      take: 500,
    });
  });

  it('limit berilmasa yoki noto`g`ri bo`lsa — 100', async () => {
    const { service, settingsRepo } = build();
    await service.listSettingsHistory({ limit: 'abc' });
    expect(settingsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});
