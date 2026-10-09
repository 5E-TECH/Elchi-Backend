import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';
// Kontrakt testi: order-service HAQIQIY webhook payload quruvchisi (precedent:
// notification-service/notification-inbox.group-key.spec.ts).
import { OrderLifecycleService } from '../../order-service/src/lifecycle/order-lifecycle.service';

/**
 * Lx5oONlP — SNAPSHOTSIZ (ESKI) SOTUVDA `collected_from_customer` ZAXIRASI.
 *
 * MUAMMO. `GET /partner/shipments/:id` ham, chiquvchi webhook ham
 * `collected_from_customer` ni FAQAT `orders.sale_collectible_amount`
 * snapshotidan olardi. Snapshot ikki xil sabab bilan `null` bo'lib qolgan
 * SOTILGAN buyurtmalar bor:
 *   • ustun (migratsiya 045, 2026-09-14) qo'shilishidan OLDIN sotilganlar;
 *   • 2026-09-14..09-24 oralig'ida sotilganlar — `updateFull` snapshotni
 *     jimgina tashlab yuborardi (2093e41 da tuzatilgan). Kartadagi #122,
 *     #123 aynan shular: `status: sold`, lekin `collected_from_customer: null`.
 * Tuzatishdan keyin YANGI sotuvlar to'ladi (#38 da 30000), eski sotuvlar
 * esa abadiy `null` qaytarardi — BeePostdagi "Elchi yig'gan (net)" ustuni
 * ular uchun bo'sh qolardi.
 *
 * YECHIM. Snapshot `null`, buyurtma esa HAQIQATAN sotilgan bo'lsa (sotuv
 * holati + `sold_at`), qiymat sotuv oqimining O'Z formulasi bilan tiklanadi:
 * `max(total_price − paid_online_amount, 0)` (`resolveCollectibleAmount`).
 * GET va webhook bitta funksiyadan (`resolvePartnerMoneyFields`, libs/common)
 * o'qiydi — ikki raqam ajralmaydi.
 */

const SOLD_AT = '1726000000000';

/** Eski (snapshotsiz) sotilgan hamkor posilkasi — #122 shakli. */
const legacySold = (over: Record<string, unknown> = {}) => ({
  id: '122',
  external_id: 'ord-122',
  operator: 'courier_5',
  status: Order_status.SOLD,
  sold_at: SOLD_AT,
  to_be_paid: 485000,
  paid_amount: 0,
  total_price: 500000,
  paid_online_amount: 0,
  extra_cost: 0,
  sale_collectible_amount: null,
  market_tariff: 15000,
  qr_code_token: 'qr-122',
  ...over,
});

function makeGetSvc(order: Record<string, unknown>) {
  const svc = Object.create(IntegrationServiceService.prototype);
  svc.partnerShipmentRefRepo = {
    findOne: jest.fn(() =>
      Promise.resolve({
        partner_id: '7',
        order_id: String(order.id),
        external_order_id: String(order.external_id),
      }),
    ),
  };
  svc.orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.find_by_id' ? of(order) : of(null),
    ),
  };
  return svc as IntegrationServiceService;
}

const getMoney = async (order: Record<string, unknown>) => {
  const res: any = await makeGetSvc(order).getPartnerShipment({
    partner_id: '7',
    shipment_id: String(order.id),
  });
  return {
    collected_from_customer: res.data.collected_from_customer,
    elchi_fee: res.data.elchi_fee,
    market_amount: res.data.market_amount,
  };
};

describe('Lx5oONlP — GET /partner/shipments/:id: snapshotsiz sotuvda zaxira', () => {
  it('⭐ eski SOTILGAN posilka (#122 shakli) -> null EMAS, sotuv formulasi', async () => {
    // Ilgari: { collected_from_customer: null, market_amount: null }.
    expect(await getMoney(legacySold())).toEqual({
      collected_from_customer: 500000,
      elchi_fee: 15000,
      market_amount: 485000,
    });
  });

  it("⭐ qisman onlayn to'langan eski sotuv -> faqat naqd qism (total − online)", async () => {
    expect(
      await getMoney(
        legacySold({ total_price: 300000, paid_online_amount: 200000 }),
      ),
    ).toEqual({
      collected_from_customer: 100000,
      elchi_fee: 15000,
      market_amount: 85000,
    });
  });

  it("⭐ to'liq onlayn to'langan eski sotuv -> 0 (null emas), qarz MANFIY", async () => {
    expect(
      await getMoney(
        legacySold({ total_price: 200000, paid_online_amount: 200000 }),
      ),
    ).toEqual({
      collected_from_customer: 0,
      elchi_fee: 15000,
      market_amount: -15000,
    });
  });

  it.each([Order_status.PAID, Order_status.PARTLY_PAID])(
    '⭐ %s (marketga to`langan eski sotuv) ham zaxira oladi',
    async (status) => {
      const money = await getMoney(legacySold({ status }));
      expect(money.collected_from_customer).toBe(500000);
      expect(money.market_amount).toBe(485000);
    },
  );

  it('snapshot BOR bo`lsa — u ustun, qayta hisoblanmaydi', async () => {
    // Sotuvdan keyin qaytarish webhooki `paid_online_amount` ni o'zgartirdi —
    // snapshot baribir sotuvdagi naqdni beradi.
    const money = await getMoney(
      legacySold({
        sale_collectible_amount: 500000,
        paid_online_amount: 50000,
      }),
    );
    expect(money.collected_from_customer).toBe(500000);
  });

  it.each([
    [
      'yo`lda (sotilmagan)',
      { status: Order_status.ON_THE_ROAD, sold_at: null },
    ],
    ['bekor qilingan', { status: Order_status.CANCELLED, sold_at: null }],
    ['yopilgan (CLOSED)', { status: Order_status.CLOSED, sold_at: null }],
    /**
     * `sold_at` siz SOLD — sotish amalidan o'tmagan (RBAC-05): kassa
     * oyoqlari umuman yozilmagan, ya'ni "yig'ildi" deyish yolg'on bo'lardi.
     */
    ['sold_at siz SOLD', { status: Order_status.SOLD, sold_at: null }],
    ['sold_at bo`sh satr', { status: Order_status.SOLD, sold_at: '  ' }],
  ])('%s -> null qoladi (zaxira YO`Q)', async (_label, over) => {
    const money = await getMoney(legacySold(over));
    expect(money.collected_from_customer).toBeNull();
    expect(money.market_amount).toBeNull();
  });
});

/** order-service webhook payload'ini (enqueue DTO) ushlab oladi. */
async function webhookDto(
  order: Record<string, unknown>,
  action: 'sold' | 'paid',
  newStatus: Order_status,
) {
  const send = jest.fn(() => of({}));
  const lifecycle = Object.create(OrderLifecycleService.prototype);
  Object.assign(lifecycle, { integrationClient: { send } });
  await lifecycle.queueExternalStatusSync(
    order,
    action,
    Order_status.SOLD,
    newStatus,
  );
  const call = send.mock.calls.find(
    (c: any[]) => c[0]?.cmd === 'integration.partner.webhook.enqueue',
  ) as any[] | undefined;
  return call?.[1] as Record<string, unknown>;
}

/** integration-service outbox'ga yozadigan HAQIQIY webhook tanasi. */
async function storedPayload(dto: Record<string, unknown>) {
  const saved: Record<string, any>[] = [];
  const s = Object.create(IntegrationServiceService.prototype);
  Object.assign(s, {
    partnerShipmentRefRepo: {
      findOne: jest.fn().mockResolvedValue({
        partner_id: '7',
        order_id: String(dto.order_id),
        external_order_id: String(dto.external_order_id),
      }),
    },
    partnerWebhookOutboxRepo: {
      create: (x: Record<string, unknown>) => x,
      save: jest.fn((x: Record<string, any>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: '1' });
      }),
    },
    processPendingPartnerWebhooks: jest.fn().mockResolvedValue(undefined),
  });
  await s.enqueuePartnerWebhook(dto);
  return saved[0]?.payload as Record<string, any>;
}

describe('Lx5oONlP — GET va webhook AYNI raqamni beradi', () => {
  it.each([
    ['eski sotuv, oddiy COD', legacySold({ status: Order_status.PAID })],
    [
      'eski sotuv, qisman onlayn',
      legacySold({
        status: Order_status.PAID,
        total_price: 300000,
        paid_online_amount: 200000,
      }),
    ],
    [
      'yangi sotuv (snapshot bor)',
      legacySold({
        status: Order_status.PAID,
        sale_collectible_amount: 30000,
        total_price: 30000,
      }),
    ],
  ])('⭐ %s', async (_label, order) => {
    const viaGet = await getMoney(order);
    const dto = await webhookDto(order, 'paid', Order_status.PAID);
    const payload = await storedPayload(dto);
    const viaWebhook = {
      collected_from_customer: payload.collected_from_customer,
      elchi_fee: payload.elchi_fee,
      market_amount: payload.market_amount,
    };

    expect(viaWebhook).toEqual(viaGet);
    // Tenglik `null === null` hisobiga o'tib ketmasin — qiymat haqiqiy son.
    expect(typeof viaGet.collected_from_customer).toBe('number');
    expect(viaGet.market_amount).toBe(
      (viaGet.collected_from_customer as number) - 15000,
    );
  });
});
