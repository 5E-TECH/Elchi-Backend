import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import type { Order } from './entities/order.entity';

/**
 * Lx5oONlP — hamkor webhooki: snapshotsiz (eski) sotuvda
 * `collected_from_customer` zaxirasi.
 *
 * Snapshot (`sale_collectible_amount`) ustundan oldin yoki `updateFull`
 * xatosi davrida (2026-09-14..09-24) sotilgan buyurtmada `null`. Shunday
 * buyurtma keyin marketga to'lansa (SOLD → PAID, `paid` webhooki) hamkorga
 * `collected_from_customer: null` ketardi — GET ham `null` berardi. Endi
 * ikkalasi sotuv formulasini (`resolveCollectibleAmount`) qo'llaydi.
 */

const SOLD_AT = '1726000000000';

const legacyOrder = (over: Partial<Order> = {}): Order =>
  ({
    id: '122',
    external_id: 'ord-122',
    operator: 'courier_5',
    status: Order_status.PAID,
    sold_at: SOLD_AT,
    paid_amount: 485000,
    total_price: 500000,
    paid_online_amount: 0,
    extra_cost: 0,
    sale_collectible_amount: null,
    market_tariff: 15000,
    ...over,
  }) as unknown as Order;

async function enqueueDto(order: Order, action: 'sold' | 'paid' | 'rollback') {
  const send = jest.fn(() => of({}));
  const svc: any = Object.create(OrderLifecycleService.prototype);
  Object.assign(svc, { integrationClient: { send } });
  await svc.queueExternalStatusSync(
    order,
    action,
    Order_status.SOLD,
    order.status,
  );
  const call = send.mock.calls.find(
    (c: any[]) => c[0]?.cmd === 'integration.partner.webhook.enqueue',
  ) as any[] | undefined;
  return call?.[1] as Record<string, unknown>;
}

describe('Lx5oONlP — webhook: snapshotsiz sotuvda zaxira', () => {
  it('⭐ eski sotuv `paid` webhooki -> collected/market_amount son (null EMAS)', async () => {
    const dto = await enqueueDto(legacyOrder(), 'paid');
    expect(dto).toEqual(
      expect.objectContaining({
        collected_from_customer: 500000,
        elchi_fee: 15000,
        market_amount: 485000,
      }),
    );
  });

  it("⭐ qisman onlayn to'langan eski sotuv -> faqat naqd qism", async () => {
    const dto = await enqueueDto(
      legacyOrder({ total_price: 300000, paid_online_amount: 200000 }),
      'paid',
    );
    expect(dto.collected_from_customer).toBe(100000);
    expect(dto.market_amount).toBe(85000);
  });

  it('snapshot bor -> snapshot (qayta hisob YO`Q)', async () => {
    const dto = await enqueueDto(
      legacyOrder({
        sale_collectible_amount: 500000,
        paid_online_amount: 50000,
      } as Partial<Order>),
      'paid',
    );
    expect(dto.collected_from_customer).toBe(500000);
  });

  it('sotilmagan buyurtma -> null qoladi', async () => {
    const dto = await enqueueDto(
      legacyOrder({
        status: Order_status.WAITING,
        sold_at: null,
      } as Partial<Order>),
      'rollback',
    );
    expect(dto.collected_from_customer).toBeNull();
    expect(dto.market_amount).toBeNull();
  });

  /**
   * QULF: zaxira formulasi sotuv oqimidagi `resolveCollectibleAmount` bilan
   * AYNAN bir xil bo'lishi shart — snapshot aynan shu qiymat bilan yoziladi.
   * Kimdir sotuv formulasini o'zgartirsa-yu, zaxirani unutsa, shu test
   * yiqiladi.
   */
  it.each([
    [500000, 0],
    [300000, 200000],
    [200000, 200000],
    [150000, 250000], // ortiqcha onlayn to'lov -> 0, manfiy emas
  ])(
    '⭐ zaxira = resolveCollectibleAmount (total=%d, online=%d)',
    async (total, online) => {
      const order = legacyOrder({
        total_price: total,
        paid_online_amount: online,
      } as Partial<Order>);
      const svc: any = Object.create(OrderLifecycleService.prototype);
      const dto = await enqueueDto(order, 'paid');
      expect(dto.collected_from_customer).toBe(
        svc.resolveCollectibleAmount(order),
      );
    },
  );
});
