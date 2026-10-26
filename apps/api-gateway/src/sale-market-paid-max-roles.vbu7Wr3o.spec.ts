import { projectOrderPayloadForRoles } from './auth/order-role-projection';

/**
 * vbu7Wr3o #3 (prod E2E Surxondaryo, 2026-10-26) — menejer sotish oynasida
 * «Marketga to'langan summa · 0 so'mdan oshmasin» (kutilgan 25 000, buyurtma
 * 133: 45 000 − markaz tarifi 20 000).
 *
 * Tekshiruv natijasi: backend sababchi EMAS — chegara rolga bog'liq bo'lmagan
 * holda `enrichOrders` da hisoblanadi (uguUEhin), menejer esa to'liq
 * ko'rinishli rol (proyeksiya qo'llanmaydi). Bu spec shuni QULFLAYDI:
 * menejer/filial xodimlari va kuryer `sale_market_paid_max` ni ro'yxatda ham,
 * detalda ham oladi; LOGIST — yo'q (4BftLLnc). Sabab — frontend menejer
 * ro'yxatining sotish oynasi (`pages/orders/index.tsx`
 * `selectedActionModalOrder`) maydonni `ActionOrder` ga ko'chirmaydi va
 * `readMarketPaidBase` `to_be_paid` (sotuvgacha 0) ga tushadi.
 */
const waitingOrder133 = () => ({
  id: '133',
  status: 'waiting',
  total_price: 45000,
  paid_online_amount: 0,
  to_be_paid: 0,
  sale_market_paid_max: 25000,
  market_id: '37',
  market: { id: '37', name: 'TEST market', tariff_center: 20000 },
});

const listPayload = () => ({
  data: [waitingOrder133()],
  total: 1,
  page: 1,
  limit: 20,
});

describe('vbu7Wr3o #3 — sale_market_paid_max rol proyeksiyasida', () => {
  it.each([['manager'], ['branch'], ['registrator'], ['superadmin']])(
    '⭐ %s: ro`yxat va detalda 25 000 qoladi',
    (role) => {
      const list = projectOrderPayloadForRoles([role], listPayload());
      expect(list.data[0].sale_market_paid_max).toBe(25000);
      const detail = projectOrderPayloadForRoles([role], {
        data: waitingOrder133(),
      });
      expect(detail.data.sale_market_paid_max).toBe(25000);
    },
  );

  it('⭐ kuryer: chegara qoladi (SellModal undan foydalanadi)', () => {
    const list = projectOrderPayloadForRoles(['courier'], listPayload());
    expect(list.data[0].sale_market_paid_max).toBe(25000);
  });

  it('market: chegara qoladi', () => {
    const list = projectOrderPayloadForRoles(['market'], listPayload());
    expect(list.data[0].sale_market_paid_max).toBe(25000);
  });

  it('⭐ LOGIST: chegara YO`Q (market tarifini ochadi, 4BftLLnc)', () => {
    const list = projectOrderPayloadForRoles(['logist'], listPayload());
    expect(list.data[0]).not.toHaveProperty('sale_market_paid_max');
    const detail = projectOrderPayloadForRoles(['logist'], {
      data: waitingOrder133(),
    });
    expect(detail.data).not.toHaveProperty('sale_market_paid_max');
  });
});
