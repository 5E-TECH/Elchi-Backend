import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DeliveryPricingService } from './delivery-pricing.service';
import type { DeliverySaleQuotePayload } from './delivery-pricing.types';

/**
 * 6tGZzupr — `logistics.delivery.sale_quote` hamkor tarifi (`GET
 * /partner/tariff`) uchun kengaytirildi: to'g'ridan o'lchov (hamkor mahsuloti
 * katalogda bo'lmasligi mumkin) va `express` / `pickup_count`. Sotuv oqimi
 * (`product_id` + soni) o'zgarmaydi — bu `KmWO9gTA` spec'ida qulflangan.
 */

const TARIFFS: Record<string, Record<string, unknown>> = {
  center: {
    id: '2',
    tariff_id: 'center',
    base_price: 40000,
    extra_per_kg: 4000,
    days_min: 1,
    days_max: 2,
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

function build() {
  const catalogClient = { send: jest.fn(() => of({ data: [] })) };
  const service = new DeliveryPricingService(
    {} as never,
    { manager: {} } as never,
    { findOne: jest.fn(() => Promise.resolve(null)) } as never,
    { findOne: jest.fn(() => Promise.resolve(null)) } as never,
    catalogClient as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
  jest
    .spyOn(service, 'findCurrentTariff')
    .mockImplementation((id: string) =>
      Promise.resolve((TARIFFS[id] as never) ?? null),
    );
  jest
    .spyOn(service, 'findActiveSettings')
    .mockImplementation(() => Promise.resolve(SETTINGS as never));
  return { service, catalogClient };
}

const quote = async (
  service: DeliveryPricingService,
  payload: Partial<DeliverySaleQuotePayload>,
) =>
  (
    (await service.saleQuote({
      where_deliver: 'center',
      items: [],
      ...payload,
    })) as { data: Record<string, any> }
  ).data;

describe('6tGZzupr — sale_quote: to`g`ridan o`lchov', () => {
  it('⭐ o`lchov bilan: dvigatel narxi, catalog chaqirilmaydi', async () => {
    const { service, catalogClient } = build();

    const data = await quote(service, {
      items: [
        {
          weight_kg: 3,
          length_cm: 30,
          width_cm: 20,
          height_cm: 40,
          quantity: 1,
        },
      ],
    });

    expect(catalogClient.send).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      tariffId: 'center',
      actualKg: 3,
      volumetricKg: 4.8,
      billableKg: 4.8,
      extraKg: 4,
      extra: 16000,
      total: 56000,
      basis: 'volume',
      estimated: false,
      base_price: 40000,
    });
  });

  it('faqat og`irlik: hajm yo`q — estimated', async () => {
    const { service } = build();

    const data = await quote(service, {
      items: [{ weight_kg: 2.5, quantity: 1 }],
    });

    expect(data).toMatchObject({
      extraKg: 2,
      missingDimensionItems: 1,
      unmeasuredItems: 0,
      estimated: true,
    });
  });

  it('o`lchovsiz element: baza tarif va estimated (jimgina 0 emas)', async () => {
    const { service } = build();

    const data = await quote(service, {
      items: [{ product_id: null, quantity: 1 }],
    });

    expect(data).toMatchObject({
      unmeasuredItems: 1,
      estimated: true,
      extra: 0,
      total: 40000,
    });
  });

  it('express va pickup hisobga kiradi (pickup total ga emas)', async () => {
    const { service } = build();

    const data = await quote(service, {
      items: [{ weight_kg: 1, quantity: 1 }],
      express: true,
      pickup_count: 1,
    });

    expect(data).toMatchObject({
      expressFee: 16000,
      pickupFee: 20000,
      total: 56000,
      totalWithPickup: 76000,
    });
  });

  it('noto`g`ri o`lchov — 400', async () => {
    const { service } = build();

    await expect(
      quote(service, { items: [{ weight_kg: -1, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('sukut: sotuv yuki (express/pickup yo`q) oldingidek', async () => {
    const { service } = build();

    const data = await quote(service, {
      items: [{ product_id: null, quantity: 1 }],
    });

    expect(data).toMatchObject({ expressFee: 0, pickupFee: 0 });
  });
});
