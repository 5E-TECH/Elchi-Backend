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
 * TASHQI SAYT IMPORTI — mijoz telefoni (zfPNDCCr).
 *
 * Ilgari faqat 12 xonali "998..." va 9 xonali shakl `+998` ga keltirilardi;
 * qolgani ("0901112233", "not-a-phone") XOM holda identity'ga ketardi —
 * bitta odam formatiga qarab alohida mijozga bo'linardi. Endi
 * `identity.customer.create` noto'g'ri raqamni 400 bilan rad etadi, ya'ni
 * import uni oldindan tashlamasa BUTUN partiya yarim yo'lda uzilardi.
 * Shuning uchun: umumiy `normalizeUzPhone` bilan kanonik ko'rinish,
 * keltirib bo'lmasa — qator `skipped: phone_invalid` (qolganlari davom etadi).
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

const run = async (orders: Record<string, unknown>[]) => {
  const { s, created } = svc();
  const res: any = await (s as any).receiveExternalOrders({
    integration_id: '5',
    orders,
  });
  return { res, created };
};

/** identity.customer.create ga ketgan telefonlar. */
const sentPhones = () =>
  rmqSend.mock.calls
    .filter(([, pattern]) => pattern?.cmd === 'identity.customer.create')
    .map(([, , payload]) => payload.dto.phone_number);

describe('receiveExternalOrders — telefon normallashtiriladi (zfPNDCCr)', () => {
  it.each([
    '998901112233',
    '+998 90 111 22 33',
    '901112233',
    '0901112233',
    '8 90 111 22 33',
  ])("⭐ %p → identity'ga '+998901112233'", async (phone) => {
    const { created } = await run([{ id: 'X1', phone, total_price: 100 }]);
    expect(sentPhones()).toEqual(['+998901112233']);
    expect(created).toHaveLength(1);
  });

  it("⭐ 'not-a-phone' → skipped: phone_invalid; identity chaqirilmaydi, keyingi qator davom etadi", async () => {
    const { res, created } = await run([
      { id: 'BAD', phone: 'not-a-phone', total_price: 100 },
      { id: 'OK', phone: '901112233', total_price: 100 },
    ]);
    expect(res.data.skipped).toEqual([
      { external_id: 'BAD', reason: 'phone_invalid' },
    ]);
    expect(sentPhones()).toEqual(['+998901112233']);
    expect(created).toHaveLength(1);
  });

  it('telefon umuman yo`q → avvalgidek phone_missing', async () => {
    const { res } = await run([{ id: 'NONE', total_price: 100 }]);
    expect(res.data.skipped).toEqual([
      { external_id: 'NONE', reason: 'phone_missing' },
    ]);
    expect(sentPhones()).toEqual([]);
  });
});
