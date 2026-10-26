import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { DeliveryPricingService } from './delivery-pricing.service';
import type { DeliverySaleQuotePayload } from './delivery-pricing.types';

/**
 * KmWO9gTA — `logistics.delivery.sale_quote` (sotuvdagi market tarifi uchun
 * vazn/hajm qo'shimchasi) va darvoza sozlamalari (`min_delivery_price`,
 * `extra_cost_limit_amount`). Hisob — `computeDeliveryQuote` (DAqXPeSy oltin
 * vektorlari bilan qulflangan); bu yerda faqat sotuvga xos farqlar.
 */

const REGIONS: Record<string, { id: string; is_city_zone: boolean }> = {
  '1': { id: '1', is_city_zone: true },
  '2': { id: '2', is_city_zone: false },
  '6': { id: '6', is_city_zone: false },
};
const DISTRICTS: Record<string, { id: string; region_id: string }> = {
  '10': { id: '10', region_id: '1' },
  '60': { id: '60', region_id: '6' },
};
const TARIFFS: Record<string, Record<string, unknown>> = {
  city: { id: '1', tariff_id: 'city', base_price: 35000, extra_per_kg: 4000 },
  center: {
    id: '2',
    tariff_id: 'center',
    base_price: 40000,
    extra_per_kg: 4000,
  },
  address: {
    id: '3',
    tariff_id: 'address',
    base_price: 60000,
    extra_per_kg: 5000,
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
  min_delivery_price: null,
  extra_cost_limit_amount: null,
  is_active: true,
};
const PRODUCTS = [
  // 30×22×15 / 1.2 kg — hajmli 1.98 kg → hisob 2.0 kg.
  {
    id: '42',
    user_id: '501',
    weight_kg: 1.2,
    length_cm: 30,
    width_cm: 22,
    height_cm: 15,
    volumetric_enabled: true,
  },
  // O'lchovsiz.
  {
    id: '43',
    user_id: '501',
    weight_kg: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    volumetric_enabled: true,
  },
];

function build(
  options: {
    noTariff?: boolean;
    catalogFails?: boolean;
    settings?: Record<string, unknown>;
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
  const catalogClient = {
    send: jest.fn((_pattern: { cmd: string }, payload: { ids: string[] }) =>
      options.catalogFails
        ? throwError(() => new Error('catalog down'))
        : of({ data: PRODUCTS.filter((p) => payload.ids.includes(p.id)) }),
    ),
  };
  const service = new DeliveryPricingService(
    {} as never,
    { manager: {} } as never,
    regionRepo as never,
    districtRepo as never,
    catalogClient as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
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
      Promise.resolve({ ...SETTINGS, ...options.settings } as never),
    );
  return { service, catalogClient };
}

const saleQuote = async (
  service: DeliveryPricingService,
  payload: Partial<DeliverySaleQuotePayload>,
) =>
  (
    (await service.saleQuote({
      where_deliver: 'center',
      items: [{ product_id: '42', quantity: 1 }],
      ...payload,
    } as DeliverySaleQuotePayload)) as { data: Record<string, any> }
  ).data;

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

describe('KmWO9gTA — logistics.delivery.sale_quote', () => {
  it('qo`shimcha = (hisob vazni − 1 kg) × kg narxi; jadval bazasi va bazalar qaytadi', async () => {
    const { service } = build();
    const data = await saleQuote(service, {
      to_region_id: '6',
      items: [{ product_id: '42', quantity: 2 }],
    });
    // 2 × (1.2 kg / 1.98 kg hajm) → hisob 4.0 kg → 3 qo'shimcha kg × 4 000.
    expect(data).toMatchObject({
      tariff_id: 'center',
      base_price: 40000,
      extra_per_kg: 4000,
      billableKg: 4,
      extraKg: 3,
      extra: 12000,
      estimated: false,
      center_base: 40000,
      address_base: 60000,
      min_delivery_price: null,
      extra_cost_limit_amount: null,
      settings_id: '1',
      tariff_row_id: '2',
    });
  });

  it('ikkala uchi shahar zonasida — city (tuman → geografik viloyat)', async () => {
    const { service } = build();
    const data = await saleQuote(service, {
      from_region_id: '1',
      to_district_id: '10',
      where_deliver: 'address',
    });
    expect(data).toMatchObject({ tariff_id: 'city', city_route: true });
  });

  it('jo`natuvchi hududi yo`q / noto`g`ri — shahar emas, xato ham emas', async () => {
    const { service } = build();
    for (const from of [
      {},
      { from_region_id: 'abc' },
      { from_region_id: '999' },
      { from_district_id: '999' },
    ]) {
      const data = await saleQuote(service, {
        ...from,
        to_region_id: '1',
        where_deliver: 'address',
      });
      expect(data.tariff_id).toBe('address');
      expect(data.extra_per_kg).toBe(5000);
    }
  });

  it('katalogsiz / topilmagan mahsulot — o`lchovsiz (404 emas), narx jimgina 0 emas', async () => {
    const { service } = build();
    const data = await saleQuote(service, {
      to_region_id: '6',
      items: [
        { product_id: '42', quantity: 1 },
        { product_id: '43', quantity: 1 },
        { product_id: '999', quantity: 1 },
        { product_id: null, quantity: 2 },
      ],
    });
    expect(data).toMatchObject({
      estimated: true,
      unmeasuredItems: 3,
      extra: 4000,
    });
  });

  it('sozlamadagi darvozalar javobda', async () => {
    const { service } = build({
      settings: { min_delivery_price: 25000, extra_cost_limit_amount: 15000 },
    });
    const data = await saleQuote(service, {});
    expect(data).toMatchObject({
      min_delivery_price: 25000,
      extra_cost_limit_amount: 15000,
    });
  });

  it('faol tarif yo`q — 409; noto`g`ri where_deliver — 400; catalog o`chiq — 503', async () => {
    expect(
      (
        await rpcError(
          build({ noTariff: true }).service.saleQuote({
            where_deliver: 'center',
            items: [],
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await rpcError(
          build().service.saleQuote({
            where_deliver: 'moon',
            items: [],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await rpcError(
          build({ catalogFails: true }).service.saleQuote({
            where_deliver: 'center',
            items: [{ product_id: '42', quantity: 1 }],
          }),
        )
      ).statusCode,
    ).toBe(503);
  });
});

describe('KmWO9gTA — darvoza sozlamalari validatsiyasi', () => {
  const validate = (payload: Record<string, unknown>) => {
    const { service } = build();
    return (
      service as unknown as {
        validateSettingsPatch: (p: Record<string, unknown>) => unknown;
      }
    ).validateSettingsPatch(payload);
  };

  it('null — o`chiq (ruxsat), musbat 2 kasrli — ruxsat', () => {
    expect(
      validate({ min_delivery_price: null, extra_cost_limit_amount: 20000.5 }),
    ).toEqual({ min_delivery_price: null, extra_cost_limit_amount: 20000.5 });
  });

  it('manfiy yoki 3 kasrli — 400', () => {
    for (const bad of [
      { min_delivery_price: -1 },
      { extra_cost_limit_amount: 1.005 },
      { min_delivery_price: 'abc' },
    ]) {
      expect(() => validate(bad)).toThrow(RpcException);
    }
  });
});
