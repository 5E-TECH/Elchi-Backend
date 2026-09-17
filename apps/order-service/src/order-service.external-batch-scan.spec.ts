/// <reference types="jest" />
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order_status } from '@app/common';
import { Order_source } from './entities/order.entity';

/**
 * QOP YORLIG'INI SKANERLASH (bitta skan → butun qop).
 *
 * ⚠️ NEGA KERAK. Hamkor 12 posilkani bitta qopda yuboradi va qop ustida
 * UMUMIY yorliq bo'ladi. Ilgari operator 12 posilkani BITTALAB skanerlashi
 * kerak edi — sekin, va bittasi o'tkazib yuborilsa jimgina qabul
 * qilinmay qolardi.
 *
 * Endi qop yorlig'i skanerlansa, u o'z qopidagi barcha posilka tokenlariga
 * ochiladi va qolgan mantiq (javobgarlik, filial, pochtaga ajratish)
 * O'ZGARISHSIZ ishlaydi — `receiveNewOrders` ayni o'sha.
 */
type Row = Record<string, unknown>;

function buildSvc(rows: {
  /** `external_batch_token` bo'yicha topilganlar (qop a'zolari). */
  batchMembers?: Row[];
  /** `qr_code_token` bo'yicha topilganlar (yakuniy to'plam). */
  byParcelToken?: Row[];
  /** Topilmagan token sababini aniqlash uchun. */
  anyOrder?: Row | null;
}) {
  const svc: any = Object.create(OrderLifecycleService.prototype);
  const findCalls: any[] = [];
  let call = 0;

  /**
   * ⚠️ MOCK SO'ROVNI HURMAT QILADI, shunchaki ro'yxat qaytarmaydi.
   *
   * Birinchi yozganimda mock `where` ni E'TIBORSIZ qoldirib, ikkinchi
   * chaqiruvga har doim to'liq ro'yxatni berardi. Natijada test kengaytirish
   * ISHLAGANINI tekshirmasdi: kengaytirishni ataylab olib tashlaganimda
   * 7 testdan faqat 1 tasi yiqildi. Endi mock `In([...])` ichidagi
   * qiymatlar bo'yicha FILTRLAYDI — ya'ni kengaytirish bo'lmasa testlar
   * haqiqatan yiqiladi.
   */
  const inValues = (op: unknown): string[] => {
    const raw = (op as { _value?: unknown })?._value;
    return Array.isArray(raw) ? raw.map((x) => String(x)) : [];
  };

  svc.orderRepo = {
    find: jest.fn((opts: any) => {
      findCalls.push(opts);
      call += 1;
      if (call === 1) {
        // Qop a'zolari: `external_batch_token` bo'yicha.
        const want = new Set(inValues(opts?.where?.external_batch_token));
        return Promise.resolve(
          (rows.batchMembers ?? []).filter((r) =>
            want.has(String(r.external_batch_token ?? '')),
          ),
        );
      }
      // Yakuniy to'plam: `qr_code_token` bo'yicha.
      const want = new Set(inValues(opts?.where?.qr_code_token));
      return Promise.resolve(
        (rows.byParcelToken ?? []).filter((r) =>
          want.has(String(r.qr_code_token ?? '')),
        ),
      );
    }),
    findOne: jest.fn(() => Promise.resolve(rows.anyOrder ?? null)),
  };
  svc.badRequest = (m: string) => {
    throw Object.assign(new Error(m), { statusCode: 400 });
  };
  const receiveCalls: any[] = [];
  svc.receiveNewOrders = jest.fn((ids: string[]) => {
    receiveCalls.push(ids);
    return Promise.resolve({ data: { received: ids.length } });
  });
  return { svc, findCalls, receiveCalls };
}

const parcel = (token: string, id: string): Row => ({
  id,
  qr_code_token: token,
  external_batch_token: 'QOP-1',
  status: Order_status.NEW,
  source: Order_source.EXTERNAL,
});

describe('receiveExternalByScan — qop yorlig`i', () => {
  it('⭐ QOP tokeni skanerlansa qopdagi BARCHA posilka qabul qilinadi', async () => {
    const { svc, receiveCalls } = buildSvc({
      batchMembers: [
        { qr_code_token: 'P-1', external_batch_token: 'QOP-1' },
        { qr_code_token: 'P-2', external_batch_token: 'QOP-1' },
        { qr_code_token: 'P-3', external_batch_token: 'QOP-1' },
      ],
      byParcelToken: [
        parcel('P-1', '1'),
        parcel('P-2', '2'),
        parcel('P-3', '3'),
      ],
    });

    const res: any = await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    // Bitta skan -> uch buyurtma.
    expect(receiveCalls[0]).toEqual(['1', '2', '3']);
    expect(res.data.received).toBe(3);
  });

  it('⭐ QOP tokeni "topilmadi" deb BELGILANMAYDI', async () => {
    /**
     * Qop tokeni posilka tokeni emas, shu bois `matched` da yo'q. Maxsus
     * tekshiruvsiz operator har qop skanidan keyin "topilmadi" xatosini
     * ko'rardi — ya'ni muvaffaqiyatli amal xato bo'lib ko'rinardi.
     */
    const { svc } = buildSvc({
      batchMembers: [{ qr_code_token: 'P-1', external_batch_token: 'QOP-1' }],
      byParcelToken: [parcel('P-1', '1')],
    });

    const res: any = await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    expect(res.data.unmatched).toEqual([]);
    expect(res.data.batch_tokens).toEqual(['QOP-1']);
  });

  it('⭐ qop a`zolarini izlashda FAQAT `NEW` va `EXTERNAL` olinadi', async () => {
    /**
     * Qopning bir qismi avval bittalab skanerlangan bo'lishi mumkin. Ularni
     * qayta olish `receiveNewOrders` ni ikki marta chaqirib javobgarlik
     * yozuvini IKKILANTIRARDI.
     */
    const { svc, findCalls } = buildSvc({
      batchMembers: [{ qr_code_token: 'P-1', external_batch_token: 'QOP-1' }],
      byParcelToken: [parcel('P-1', '1')],
    });

    await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    expect(findCalls[0].where).toMatchObject({
      status: Order_status.NEW,
      source: Order_source.EXTERNAL,
    });
  });

  it('POSILKA tokeni oldingidek ishlaydi (regressiya)', async () => {
    const { svc, receiveCalls } = buildSvc({
      batchMembers: [], // hech bir qop mos kelmadi
      byParcelToken: [parcel('P-9', '9')],
    });

    const res: any = await svc.receiveExternalByScan({ tokens: ['P-9'] });

    expect(receiveCalls[0]).toEqual(['9']);
    expect(res.data.batch_tokens).toEqual([]);
  });

  it('⭐ ARALASH skan: bitta posilka + bitta qop', async () => {
    const { svc, receiveCalls } = buildSvc({
      batchMembers: [
        { qr_code_token: 'P-1', external_batch_token: 'QOP-1' },
        { qr_code_token: 'P-2', external_batch_token: 'QOP-1' },
      ],
      byParcelToken: [
        parcel('P-1', '1'),
        parcel('P-2', '2'),
        parcel('YOLG-9', '9'),
      ],
    });

    const res: any = await svc.receiveExternalByScan({
      tokens: ['QOP-1', 'YOLG-9'],
    });

    expect(receiveCalls[0].sort()).toEqual(['1', '2', '9']);
    expect(res.data.received).toBe(3);
  });

  it('⭐ qop BO`SH bo`lsa (hammasi qabul qilingan) — aniq sabab', async () => {
    const { svc } = buildSvc({
      batchMembers: [],
      byParcelToken: [],
      anyOrder: {
        qr_code_token: 'QOP-1',
        source: Order_source.EXTERNAL,
        status: Order_status.RECEIVED,
      },
    });

    const res: any = await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    expect(res.data.received).toBe(0);
    expect(res.data.unmatched).toHaveLength(1);
  });

  it('bo`sh token ro`yxati -> 400', async () => {
    const { svc } = buildSvc({});
    await expect(svc.receiveExternalByScan({ tokens: [] })).rejects.toThrow(
      /tokens is required/,
    );
  });
});
