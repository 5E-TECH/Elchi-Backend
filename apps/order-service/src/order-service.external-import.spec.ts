/**
 * `rmqSend` — modul funksiyasi; import mijozni identity-service'da yaratadi.
 * Uni mock qilamiz, aks holda test RMQ ulanishini kutib qolardi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rmqSend } = require('@app/common') as { rmqSend: jest.Mock };

import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

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

describe('EI-06 — `region` matn bo\'lsa 500 bermaydi', () => {
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

  it('bo\'sh va yo\'q qiymat `null`', async () => {
    expect((await run({ id: 'X3', phone: '+998901112233', region: '' })).region_id).toBeNull();
    expect((await run({ id: 'X4', phone: '+998901112233' })).region_id).toBeNull();
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

  it('⭐ katalogga BOG\'LANMAYDI (`product_id: null`)', async () => {
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

  it('noto\'g\'ri son 1 ga tushadi', async () => {
    const dto = await run({
      id: 'Y4',
      phone: '+998901112233',
      items: [{ name: 'A', quantity: -5 }, { name: 'B', quantity: 'salom' }],
    });
    expect(dto.items.map((i: any) => i.quantity)).toEqual([1, 1]);
  });

  it('`items` massiv bo\'lmasa bo\'sh ro\'yxat — yiqilmaydi', async () => {
    const dto = await run({
      id: 'Y5',
      phone: '+998901112233',
      items: 'salom',
    });
    expect(dto.items).toEqual([]);
  });
});
