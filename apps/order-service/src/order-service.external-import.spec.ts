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
 * 3-BOSQICH: TASHQI SAYTDAN IMPORT.
 *
 * Ikki nuqson qulflanadi:
 *
 * EI-06 — `region_id` bigint FK, sayt esa u yerga "Toshkent" kabi MATN
 * yuborishi mumkin edi va u XOM yozilardi. Postgres tip xatosi (`22P02`)
 * chiqarardi, import esa bittalab ketgani uchun partiya YARIM YO'LDA
 * uzilardi — bir qismi yaratilib, qolgani yo'q.
 *
 * EI-12 — import qilingan buyurtmada MAHSULOT QATORLARI umuman yo'q edi:
 * operator narxi bor, ichida nima borligi ko'rinmaydigan posilkani ko'rardi
 * va qisman sotish ishlamasdi.
 */

function svc() {
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
      /**
       * ⚠️ `resolveDistrictIdOrNull` — mos kelmasa `null`. Zaxira tuman
       * (jadvaldagi birinchi) ni chaqiruvchi o'zi qo'yadi, shu bois
       * "aniqlandimi" degan savolga javob shu metoddan keladi.
       */
      resolveDistrictIdOrNull: jest.fn().mockResolvedValue('12'),
      resolveDistrictId: jest.fn().mockResolvedValue('12'),
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

const run = async (order: Record<string, unknown>) => {
  const { s, created } = svc();
  await (s as any).receiveExternalOrders({
    integration_id: '5',
    orders: [order],
  });
  return created[0];
};

/** To'liq javobni qaytaradi — `skipped` sabablarini ko'rish uchun. */
const runFull = async (
  order: Record<string, unknown>,
  options?: { strict?: boolean },
  over?: (svcObj: any) => void,
) => {
  const { s, created } = svc();
  over?.(s);
  const res: any = await (s as any).receiveExternalOrders({
    integration_id: '5',
    orders: [order],
    options,
  });
  return { res, created };
};

const VALID = { id: 'X1', phone: '+998901112233', total_price: 100 };

describe("EI-06 — `region` matn bo'lsa 500 bermaydi", () => {
  it('⭐ MATN region `null` ga tushadi (ilgari xom yozilardi)', async () => {
    const dto = await run({
      id: 'X1',
      phone: '+998901112233',
      full_name: 'Ali',
      region: 'Toshkent',
    });
    expect(dto.region_id).toBeNull();
  });

  it('SON region saqlanadi', async () => {
    const dto = await run({
      id: 'X2',
      phone: '+998901112233',
      region: '14',
    });
    expect(dto.region_id).toBe('14');
  });

  it("bo'sh va yo'q qiymat `null`", async () => {
    expect(
      (await run({ id: 'X3', phone: '+998901112233', region: '' })).region_id,
    ).toBeNull();
    expect(
      (await run({ id: 'X4', phone: '+998901112233' })).region_id,
    ).toBeNull();
  });

  it('⭐ aralash qiymat ham rad etiladi (SQL injektsiya shakli ham)', async () => {
    /**
     * `14; DROP TABLE` kabi qiymat ham SON emas. Parametrlangan so'rov
     * himoya qiladi, lekin bu yerda ham to'siq bo'lishi yaxshi.
     */
    const dto = await run({
      id: 'X5',
      phone: '+998901112233',
      region: '14; DROP TABLE orders',
    });
    expect(dto.region_id).toBeNull();
  });

  it('marshrutlash region_id ga tayanmaydi — tuman saqlanadi', async () => {
    // Pochtaga ajratish tumandan olingan `assigned_region` bo'yicha ishlaydi.
    const dto = await run({
      id: 'X6',
      phone: '+998901112233',
      region: 'Buxoro',
      district: '1726269',
    });
    expect(dto.region_id).toBeNull();
    expect(dto.district_id).toBe('12');
  });
});

describe('EI-12 — mahsulot qatorlari', () => {
  it('⭐ `items` massivi buyurtma qatorlariga aylanadi', async () => {
    const dto = await run({
      id: 'Y1',
      phone: '+998901112233',
      items: [
        { name: 'Telefon', quantity: 2 },
        { name: 'Quloqchin', quantity: 1 },
      ],
    });
    expect(dto.items).toEqual([
      { product_id: null, product_name: 'Telefon', quantity: 2 },
      { product_id: null, product_name: 'Quloqchin', quantity: 1 },
    ]);
  });

  it("⭐ katalogga BOG'LANMAYDI (`product_id: null`)", async () => {
    /**
     * Ataylab: kichik saytlarning mahsulot id'lari bizning katalogimizga mos
     * kelmaydi va har nomni katalogda yaratish uni axlatga to'ldirardi.
     */
    const dto = await run({
      id: 'Y2',
      phone: '+998901112233',
      items: [{ name: 'Narsa' }],
    });
    expect(dto.items[0].product_id).toBeNull();
    expect(dto.items[0].quantity).toBe(1);
  });

  it('nomsiz qator TASHLANADI', async () => {
    // Yarim to'ldirilgan qator buyurtmani buzardi.
    const dto = await run({
      id: 'Y3',
      phone: '+998901112233',
      items: [{ name: '' }, { name: '   ' }, { name: 'Bor' }],
    });
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].product_name).toBe('Bor');
  });

  it("noto'g'ri son 1 ga tushadi", async () => {
    const dto = await run({
      id: 'Y4',
      phone: '+998901112233',
      items: [
        { name: 'A', quantity: -5 },
        { name: 'B', quantity: 'salom' },
      ],
    });
    expect(dto.items.map((i: any) => i.quantity)).toEqual([1, 1]);
  });

  it("`items` massiv bo'lmasa bo'sh ro'yxat — yiqilmaydi", async () => {
    const dto = await run({
      id: 'Y5',
      phone: '+998901112233',
      items: 'salom',
    });
    expect(dto.items).toEqual([]);
  });
});

describe('⭐ NARX — `NaN` moliyani zaharlaydi', () => {
  /**
   * ADVERSARIAL TOPILMA (kritik). `Number('250 000')` → `NaN`,
   * `Math.max(NaN, 0)` → `NaN`. Postgres `numeric` ustuni `NaN` ni QABUL
   * QILADI, ya'ni xato chiqmaydi: buyurtma yaratiladi va undan keyin
   * market hisobi, kassa yig'indisi, dashboard — hammasi `NaN` bo'lib
   * qoladi. Eng yomon turdagi xato: jimgina va butun moliyani buzadi.
   */
  it("son bo'lmagan narx qatorni TASHLAYDI", async () => {
    const { res, created } = await runFull({
      ...VALID,
      total_price: '250 000',
    });

    expect(created).toHaveLength(0);
    expect(res.data.skipped[0]).toMatchObject({ reason: 'price_invalid' });
  });

  it('yetkazish narxi ham tekshiriladi', async () => {
    const { res } = await runFull({ ...VALID, delivery_price: 'tekin' });
    expect(res.data.skipped[0]).toMatchObject({ reason: 'price_invalid' });
  });

  it("bo'sh yoki yo'q narx 0 — bu QONUNIY holat", async () => {
    // Bepul yoki oldindan to'langan posilka.
    const dto = await run({ id: 'X1', phone: '+998901112233' });
    expect(dto.total_price).toBe(0);
  });

  it("satrdagi to'g'ri son qabul qilinadi", async () => {
    const dto = await run({ ...VALID, total_price: '150000' });
    expect(dto.total_price).toBe(150000);
  });

  it('⭐ QAT`IY rejimda narx BERILGAN bo`lishi shart', async () => {
    /**
     * Kalit mos kelmasa `undefined` → 0 bo'lib ketardi, ya'ni COD 0:
     * kuryer puldan qaytardi va hech kim sababini bilmasdi. CRM yo'lida
     * bunga yo'l qo'yilmaydi.
     */
    const { res, created } = await runFull(
      { id: 'X1', phone: '+998901112233' },
      { strict: true },
    );

    expect(created).toHaveLength(0);
    expect(res.data.skipped[0]).toMatchObject({ reason: 'price_missing' });
  });
});

describe('⭐ TUMAN — zaxira jimgina boshqa viloyatga yuborardi', () => {
  /**
   * ADVERSARIAL TOPILMA. `resolveDistrictId` mos kelmasa zaxira qiymatni
   * qaytaradi, zaxira esa `getDefaultDistrictId()` — JADVALDAGI BIRINCHI
   * tuman. Tuman viloyat va pochta marshrutini, tarifni ham belgilaydi.
   *
   * Ustiga moslik faqat SOATO kodi yoki ichki ID bo'yicha izlanadi —
   * NOM bo'yicha EMAS. Ya'ni "Chilonzor" deb yuborgan CRM'ning HAR BIR
   * buyurtmasi birinchi tumanga tushardi.
   */
  const unresolved = (svcObj: any) => {
    svcObj.lookup.resolveDistrictIdOrNull = jest.fn().mockResolvedValue(null);
  };

  it('oddiy rejimda zaxira ISHLATILADI (xatti-harakat o`zgarmadi)', async () => {
    const { res, created } = await runFull(VALID, undefined, unresolved);

    expect(res.data.skipped).toHaveLength(0);
    expect(created[0].district_id).toBe('1'); // getDefaultDistrictId
  });

  it('⭐ QAT`IY rejimda buyurtma YARATILMAYDI', async () => {
    const { res, created } = await runFull(VALID, { strict: true }, unresolved);

    expect(created).toHaveLength(0);
    expect(res.data.skipped[0]).toMatchObject({
      reason: 'district_unresolved',
    });
  });
});

describe("⭐ SKAN TOKENI — to'qnashuv darvozani zaharlaydi", () => {
  /**
   * ADVERSARIAL TOPILMA. `qr_code_field` ATAYLAB qoladi: tashqi sayt o'z
   * shtrix-kodini posilkaga bosib chiqaradi va pochta AYNI o'sha kodni
   * skaner qiladi. Lekin token skanerlab qabul qilish darvozasining
   * KALITI — dublikat bo'lsa skanerlash BOSHQA buyurtmaga tushib ketardi.
   */
  it('mavjud token bilan buyurtma yaratilmaydi', async () => {
    const { res, created } = await runFull(
      { ...VALID, qr_code: 'TOKEN-1' },
      undefined,
      (svcObj) => {
        // Dublikat tekshiruvi `null`, token tekshiruvi esa mavjud qator.
        svcObj.orderRepo.findOne = jest.fn((q: any) =>
          q?.where?.qr_code_token ? { id: '99' } : null,
        );
      },
    );

    expect(created).toHaveLength(0);
    expect(res.data.skipped[0]).toMatchObject({ reason: 'qr_code_conflict' });
  });

  it('token berilmasa o`zimiz yasaymiz', async () => {
    const dto = await run(VALID);
    expect(String(dto.qr_code_token ?? '').length).toBeGreaterThan(0);
  });
});
