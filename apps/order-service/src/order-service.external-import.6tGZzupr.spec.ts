/**
 * `rmqSend` — modul funksiyasi; import mijozni identity-service'da yaratadi.
 * Uni mock qilamiz, aks holda test RMQ ulanishini kutib qolardi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { rmqSend as rmqSendFn } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

const rmqSend = rmqSendFn as unknown as jest.Mock;

/**
 * 6tGZzupr — tashqi importdagi `delivery_price` — bu TASHQI DO'KONNING narxi,
 * Elchi tarifi EMAS: u faqat COD summasiga qo'shiladi, `market_tariff` /
 * `quoted_market_tariff` ga tushmaydi va dvigatelga bormaydi. Elchi tarifi
 * sotuvda alohida aniqlanadi.
 */
function svc() {
  rmqSend.mockReset();
  rmqSend.mockResolvedValue({ data: { id: 'c1' } });
  const created: Record<string, any>[] = [];
  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;

  Object.assign(s, {
    orderRepo: { findOne: jest.fn().mockResolvedValue(null) },
    lookup: {
      getIntegrationById: jest.fn().mockResolvedValue({
        id: '5',
        slug: 'donoxon',
        market_id: '500',
        is_active: true,
        field_mapping: {},
      }),
      getDefaultDistrictId: jest.fn().mockResolvedValue('1'),
      resolveDistrictIdOrNull: jest.fn().mockResolvedValue('12'),
      resolveDistrictId: jest.fn().mockResolvedValue('12'),
      resolveRegionIdForDistrict: jest.fn().mockResolvedValue('9'),
    },
    create: jest.fn((dto: Record<string, any>) => {
      created.push(dto);
      return Promise.resolve({ id: String(created.length), ...dto });
    }),
    badRequest: (m: string) => {
      throw Object.assign(new Error(m), { statusCode: 400 });
    },
  });
  return { s, created };
}

describe('6tGZzupr — tashqi import delivery_price Elchi tarifi bilan aralashmaydi', () => {
  it('⭐ do`kon narxi faqat COD summasida; tarif maydonlari va dvigatel tegilmaydi', async () => {
    const { s, created } = svc();

    await (s as any).receiveExternalOrders({
      integration_id: '5',
      orders: [
        {
          id: 'X1',
          phone: '+998901112233',
          total_price: 100000,
          delivery_price: 15000,
        },
      ],
    });

    expect(created).toHaveLength(1);
    expect(created[0].total_price).toBe(115000);
    for (const key of [
      'market_tariff',
      'quoted_market_tariff',
      'courier_tariff',
      'delivery_price',
    ]) {
      expect(created[0]).not.toHaveProperty(key);
    }
    expect(
      rmqSend.mock.calls.some(([, pattern]) =>
        String((pattern as { cmd?: string })?.cmd ?? '').startsWith(
          'logistics.delivery.',
        ),
      ),
    ).toBe(false);
  });
});
