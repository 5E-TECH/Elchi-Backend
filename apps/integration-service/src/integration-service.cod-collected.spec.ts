import { IntegrationServiceService } from './integration-service.service';
import { Order_status } from '@app/common';

/**
 * F1 — `cod_collected` MATEMATIK JIHATDAN HAR DOIM 0 EDI.
 *
 * Ikki shart bir-birini yo'q qilardi:
 *   • qiymat FAQAT `newStatus === 'sold'` bo'lganda yuborilardi;
 *   • status `sold` bo'lishining YAGONA sharti esa `paidAfter === 0`
 *     (`order-lifecycle.service.ts:3910`: `paidAfter > 0` → `paid`/`partly_paid`).
 * Ya'ni `sold` ⟺ `paid_amount = 0`, demak hamkor har doim 0 olardi.
 *
 * ⚠️ NOM HAM CHALG'ITADI: `paid_amount` mijozdan yig'ilgan pul EMAS, u market
 * qarzining to'langan qismi. Shu bois aniq nomli maydonlar qo'shildi.
 */

function svc() {
  const saved: Record<string, unknown>[] = [];
  const s = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, any>;
  Object.assign(s, {
    partnerShipmentRefRepo: {
      findOne: jest.fn().mockResolvedValue({
        partner_id: '7',
        order_id: '1001',
        external_order_id: 'EXT-1',
      }),
    },
    partnerWebhookOutboxRepo: {
      findOne: jest.fn().mockResolvedValue(null),
      create: (x: Record<string, unknown>) => x,
      save: jest.fn((x: Record<string, unknown>) => {
        saved.push(x);
        return Promise.resolve({ ...x, id: '1' });
      }),
    },
    partnerRepo: {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: '7', webhook_url: 'https://a.uz/h' }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    deliverPartnerWebhook: jest.fn().mockResolvedValue(undefined),
    signPayload: () => 'sig',
    encryptCredential: (v: string) => v,
    decryptCredential: (v: string) => v,
  });
  return { s, saved };
}

const enqueue = async (
  over: Record<string, unknown>,
): Promise<Record<string, any>> => {
  const { s, saved } = svc();
  await (s as any).enqueuePartnerWebhook({
    order_id: '1001',
    external_order_id: 'EXT-1',
    ...over,
  });
  return (saved[0]?.payload ?? {}) as Record<string, any>;
};

describe('F1 — cod_collected darvozasi olib tashlandi', () => {
  it("⭐ `paid` holatida ham qiymat YUBORILADI (ilgari 0 bo'lardi)", async () => {
    const payload = await enqueue({
      new_status: Order_status.PAID,
      cod_collected: 450000,
    });
    expect(payload.cod_collected).toBe(450000);
  });

  it('⭐ `partly_paid` holatida ham yuboriladi', async () => {
    const payload = await enqueue({
      new_status: Order_status.PARTLY_PAID,
      cod_collected: 200000,
    });
    expect(payload.cod_collected).toBe(200000);
  });

  it('`sold` holatida ham ishlaydi (avvalgi yagona holat)', async () => {
    const payload = await enqueue({
      new_status: Order_status.SOLD,
      cod_collected: 0,
    });
    expect(payload.cod_collected).toBe(0);
  });

  it('⭐ aniq nomli maydonlar ham ketadi', async () => {
    /**
     * `cod_collected` nomi hamkor kontraktida e'lon qilingan, shuning uchun
     * olib tashlanmadi — lekin yoniga to'g'ri nomlari qo'shildi.
     */
    const payload = await enqueue({
      new_status: Order_status.PAID,
      cod_collected: 450000,
      cod_amount: 500000,
    });
    expect(payload.market_paid_amount).toBe(450000);
    expect(payload.cod_amount).toBe(500000);
  });

  it("son bo'lmagan qiymat 0 ga tushadi (NaN ketmaydi)", async () => {
    const payload = await enqueue({
      new_status: Order_status.PAID,
      cod_collected: Number.NaN,
    });
    expect(payload.cod_collected).toBe(0);
    expect(payload.market_paid_amount).toBe(0);
  });

  it("⭐ BEKOR qilishda 0 — qiymat berilgan bo'lsa ham", async () => {
    /**
     * Darvozani butunlay olib tashlash XATO bo'lardi: bekor qilingan
     * posilkada pul yig'ilmagan. Aks holda hamkor bekor qilingan buyurtma
     * uchun pul olgandek yozib qo'yardi. Mavjud test aynan shuni tutdi.
     */
    const payload = await enqueue({
      new_status: Order_status.CANCELLED,
      cod_collected: 50000,
    });
    expect(payload.cod_collected).toBe(0);
    expect(payload.market_paid_amount).toBe(0);
  });

  it('qaytarilgan posilkada ham 0', async () => {
    const payload = await enqueue({
      new_status: Order_status.RETURNED_TO_MARKET,
      cod_collected: 50000,
    });
    expect(payload.cod_collected).toBe(0);
  });
});
