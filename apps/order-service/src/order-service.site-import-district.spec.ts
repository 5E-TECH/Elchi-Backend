/**
 * SAYT IMPORTI — TUMAN VA VILOYAT (prod hodisasi 2026-11-24/25).
 *
 * MUAMMO. «Tashqi saytlar» skanidan qabul qilingan 58 ta buyurtmaning
 * HAMMASI bitta tumanga (Bektemir, jadvaldagi birinchi qator) va Toshkent
 * shahri pochtasiga tushdi: sayt Andijon / Buxoro / Jizzax … tumanlarining
 * to'g'ri SOATO kodini yuborgan bo'lsa ham. Ikki nuqson ustma-ust edi:
 *
 *  1. order-service `logistics.district.find_by_sato` ga `{ satoCode }`
 *     yuborardi, logistics esa `sato_code` ni o'qiydi. `undefined` shart
 *     TypeORM'da TASHLAB YUBORILADI — jadvaldagi birinchi tuman qaytardi va
 *     chaqiruvchi uni haqiqiy moslik deb qabul qilardi (qat'iy rejim ham).
 *  2. Saytning `region` i (SOATO viloyat kodi, masalan 1703) Elchi viloyat
 *     id'si deb buyurtmaga yozilardi — bunday viloyat yo'q.
 *
 * Bu spec ikki servisning HAQIQIY kodini ulaydi: lookup yuborgan yuk
 * logistics kontrolleriga o'zgarishsiz beriladi. Mock'langan `rmqSend` bilan
 * yozilgan eski speclar aynan shu nomuvofiqlikni ko'rmagan edi.
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { rmqSend as rmqSendFn } from '@app/common';
import { LogisticsServiceController } from '../../logistics-service/src/logistics-service.controller';
import { LogisticsServiceService } from '../../logistics-service/src/logistics-service.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderLookupService } from './lookup/order-lookup.service';

const rmqSend = rmqSendFn as unknown as jest.Mock;

type Row = Record<string, any>;

/** Jadval tartibi muhim: birinchisi — prod'dagi kabi Bektemir. */
const DISTRICTS: Row[] = [
  { id: '1', name: 'Bektemir', sato_code: '1726283', region_id: '1' },
  { id: '30', name: 'Jalaquduq', sato_code: '1703211', region_id: '3' },
  {
    id: '44',
    name: "G'ijduvon",
    sato_code: '1706215',
    region_id: '4',
    assigned_region: '9',
  },
];

/** TypeORM kabi: `undefined` shart tashlab yuboriladi, birinchi qator qaytadi. */
const districtRepo = {
  findOne: jest.fn(({ where }: { where: Row }) =>
    Promise.resolve(
      DISTRICTS.find((row) =>
        Object.entries(where).every(
          ([key, value]) =>
            value === undefined || String(row[key]) === String(value),
        ),
      ) ?? null,
    ),
  ),
  find: jest.fn(() => Promise.resolve([...DISTRICTS].reverse())),
};

function makeLogistics() {
  const service = Object.create(LogisticsServiceService.prototype) as Row;
  Object.assign(service, { districtRepo });
  const controller = Object.create(LogisticsServiceController.prototype) as Row;
  Object.assign(controller, {
    logisticsService: service,
    executeAndAck: (_ctx: unknown, run: () => Promise<unknown>) => run(),
  });
  return { service, controller };
}

function makeOrderService() {
  const { controller } = makeLogistics();
  rmqSend.mockReset();
  rmqSend.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: any) => {
      switch (pattern.cmd) {
        case 'logistics.district.find_by_sato':
          return controller.findDistrictBySatoCode(payload, {});
        case 'logistics.district.find_by_id':
          return controller.findDistrictById(payload, {});
        case 'logistics.district.find_all':
          return controller.findAllDistricts(payload, {});
        case 'identity.customer.create':
          return Promise.resolve({ data: { id: 'c1' } });
        default:
          return Promise.reject(new Error(`kutilmagan RPC: ${pattern.cmd}`));
      }
    },
  );

  const lookup = Object.create(OrderLookupService.prototype) as Row;
  Object.assign(lookup, {
    logisticsClient: {},
    getIntegrationById: jest.fn().mockResolvedValue({
      id: '3',
      slug: 'lidershop',
      market_id: '3949',
      is_active: true,
      field_mapping: null,
    }),
  });

  const created: Row[] = [];
  const service = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(service, {
    lookup,
    identityClient: {},
    orderRepo: { findOne: jest.fn().mockResolvedValue(null) },
    create: jest.fn((dto: Row) => {
      created.push(dto);
      return Promise.resolve({ id: String(created.length), ...dto });
    }),
  });
  return { service, lookup, created };
}

/** Prod'dagi sayt javobi shakli (Lidershop, 2026-11-24). */
const siteOrder = (over: Row = {}): Row => ({
  id: 56556,
  qr_code: '1795491722945589',
  full_name: 'Mijoz',
  phone: '901112233',
  region: 1703,
  district: 1703211,
  total_price: 99000,
  delivery_price: 30000,
  items: "Diskali soat x 1 = 99 000 so'm",
  ...over,
});

const importOne = async (over: Row = {}, options?: { strict?: boolean }) => {
  const { service, created } = makeOrderService();
  const result = await service.receiveExternalOrders({
    integration_id: '3',
    orders: [siteOrder(over)],
    options,
  });
  return { result, created };
};

describe('sayt importi — tuman SOATO kodi bo`yicha', () => {
  it('⭐ lookup yuborgan kod logistics`ga yetadi — o`sha tuman topiladi', async () => {
    const { lookup } = makeOrderService();
    await expect(lookup.resolveExternalDistrict(1703211)).resolves.toEqual({
      id: '30',
      sato_code: '1703211',
    });
    await expect(
      lookup.resolveExternalDistrict('1706215'),
    ).resolves.toMatchObject({ id: '44' });
  });

  it('⭐ noma`lum SOATO — `null` (jadvaldagi birinchi tuman EMAS)', async () => {
    const { lookup } = makeOrderService();
    await expect(lookup.resolveExternalDistrict('1799999')).resolves.toBeNull();
  });

  it('⭐ prod holati: Jalaquduq (1703211) buyurtmasi o`z tumani va viloyatida', async () => {
    const { created } = await importOne();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ district_id: '30', region_id: '3' });
  });

  it('⭐ saytning SOATO viloyat kodi (1703) `region_id` ga YOZILMAYDI', async () => {
    const { created } = await importOne({ region: 1703 });
    expect(created[0].region_id).not.toBe('1703');
  });

  it('viloyat — tumanning xizmat viloyati (`assigned_region` ustun)', async () => {
    const { created } = await importOne({ district: 1706215, region: 1706 });
    expect(created[0]).toMatchObject({ district_id: '44', region_id: '9' });
  });

  it.each([undefined, { strict: true }])(
    '⭐ noma`lum tuman — buyurtma yaratilmaydi (rejim: %p)',
    async (options) => {
      const { result, created } = await importOne(
        { district: '1799999', region: 1799 },
        options,
      );
      expect(created).toHaveLength(0);
      expect(result.data.skipped[0]).toMatchObject({
        reason: 'district_unresolved',
      });
    },
  );
});

/**
 * QAYTMASLIK KAFOLATI (ega 2026-11-25). Kod yana xato qilsa ham buyurtma
 * noto'g'ri tumanga JIMGINA tushmaydi.
 */
describe('himoya — noto`g`ri tuman jimgina yozilmaydi', () => {
  /** 2026-11-24 dagi logistics: har qanday kodga birinchi tuman. */
  const brokenLogistics = (
    _client: unknown,
    pattern: { cmd: string },
  ): Promise<unknown> =>
    pattern.cmd === 'identity.customer.create'
      ? Promise.resolve({ data: { id: 'c1' } })
      : Promise.resolve({ statusCode: 200, data: DISTRICTS[0] });

  it('⭐ logistics boshqa tuman qaytarsa — rad etiladi va logga ERROR yoziladi', async () => {
    const { lookup, service, created } = makeOrderService();
    const error = jest.fn();
    lookup.logger = { error, warn: jest.fn() };
    rmqSend.mockImplementation(brokenLogistics);

    const result = await service.receiveExternalOrders({
      integration_id: '3',
      orders: [siteOrder()],
    });

    expect(created).toHaveLength(0);
    expect(result.data.skipped[0].reason).toBe('district_unresolved');
    expect(error).toHaveBeenCalled();
  });

  it('⭐ logistics javob bermasa ham zaxira tuman qo`yilmaydi', async () => {
    const { service, created } = makeOrderService();
    rmqSend.mockRejectedValue(new Error('timeout'));
    const result = await service.receiveExternalOrders({
      integration_id: '3',
      orders: [siteOrder()],
    });
    expect(created).toHaveLength(0);
    expect(result.data.skipped[0].reason).toBe('district_unresolved');
  });

  it('⭐ saytning viloyati tumanga zid (1703 ↔ 1706215) — yaratilmaydi', async () => {
    const { result, created } = await importOne({
      region: 1703,
      district: 1706215,
    });
    expect(created).toHaveLength(0);
    expect(result.data.skipped[0]).toMatchObject({ reason: 'region_mismatch' });
  });

  it.each([1703, '1703', null, undefined, '', 'Andijon', 3])(
    'viloyat mos / yo`q / SOATO emas (%p) — yaratiladi',
    async (region) => {
      const { created } = await importOne({ region });
      expect(created).toHaveLength(1);
      expect(created[0].district_id).toBe('30');
    },
  );
});

describe('logistics — bo`sh kod / id hech qachon «birinchi tuman» emas', () => {
  it.each([undefined, null, '', '   '])('sato_code=%p → 404', async (value) => {
    const { controller } = makeLogistics();
    await expect(
      controller.findDistrictBySatoCode({ sato_code: value }, {}),
    ).rejects.toMatchObject({ error: { statusCode: 404 } });
  });

  it.each([undefined, null, '', '   '])('id=%p → 404', async (value) => {
    const { controller } = makeLogistics();
    await expect(
      controller.findDistrictById({ id: value }, {}),
    ).rejects.toMatchObject({ error: { statusCode: 404 } });
  });
});
