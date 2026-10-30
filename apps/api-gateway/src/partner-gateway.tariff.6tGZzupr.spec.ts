/// <reference types="jest" />
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { readFileSync } from 'fs';
import { join } from 'path';
import { of, throwError } from 'rxjs';
import { PartnerGatewayController } from './partner-gateway.controller';

/**
 * 6tGZzupr — `GET /partner/tariff` dvigatelga ulandi.
 *
 * Asosiy qoidalar:
 *   - `market_tariff` — ELCHI SOTUVDA OLADIGAN summa (`resolveOrderTariffDetailed`
 *     yagona manba): `SALE_PRICING_ENGINE` o'chiq (sukut) — profil tarifi, prod
 *     narxi o'zgarmaydi; yoqiq — standart narx + vazn/hajm qo'shimchasi;
 *   - `quote` — dvigatel hisobi (`computeDeliveryQuote`), kalitdan qat'i nazar;
 *   - o'lchovsiz — `estimated: true` va baza tarif, jimgina 0 EMAS;
 *   - yangi maydonsiz eski so'rov — logistics'ga bormaydi, `market_tariff` AYNI.
 */

const partnerReq = { partner: { id: '7', name: 'Acme' } };

const market = (over: Record<string, unknown> = {}) => ({
  id: 77,
  username: 'mp7_shop1',
  tariff_home: 15000,
  tariff_center: 10000,
  region_id: '5',
  district_id: '50',
  ...over,
});

/** `logistics.delivery.sale_quote` javobi (`computeDeliveryQuote` + sozlamalar). */
const saleQuote = (over: Record<string, unknown> = {}) => ({
  tariffId: 'center',
  base: 40000,
  perExtraKg: 4000,
  daysMin: 1,
  daysMax: 2,
  actualKg: 3,
  volumetricKg: 2.4,
  volumetricFromKg: 0,
  volumetricApplied: true,
  billableKg: 3,
  extraKg: 2,
  extra: 8000,
  subtotal: 48000,
  expressFee: 0,
  pickupFee: 0,
  total: 48000,
  totalWithPickup: 48000,
  basis: 'weight',
  unmeasuredItems: 0,
  missingDimensionItems: 0,
  estimated: false,
  tariff_id: 'center',
  tariff_row_id: '2',
  base_price: 40000,
  extra_per_kg: 4000,
  city_route: false,
  settings_id: '1',
  min_delivery_price: null,
  extra_cost_limit_amount: null,
  center_base: 40000,
  address_base: 60000,
  ...over,
});

const logisticsOk = (over: Record<string, unknown> = {}) =>
  jest.fn(() => of({ data: saleQuote(over) }));

const identityOf = (row: Record<string, unknown>) =>
  jest.fn(() => of({ data: [row] }));

const controller = (logistics: jest.Mock, identity: jest.Mock) =>
  new PartnerGatewayController(
    { send: logistics } as unknown as ClientProxy,
    { send: identity } as unknown as ClientProxy,
    { send: jest.fn() } as unknown as ClientProxy,
  );

const MEASURED = {
  weight_kg: '3',
  length_cm: '30',
  width_cm: '20',
  height_cm: '40',
};

const call = (
  logistics: jest.Mock,
  query: Record<string, unknown> = {},
  row: Record<string, unknown> = market(),
) =>
  controller(logistics, identityOf(row)).getTariff(
    '77',
    (query.where_deliver as string | undefined) ?? 'center',
    partnerReq,
    query,
  );

const salePayload = (logistics: jest.Mock) => {
  const quoteCalls = logistics.mock.calls.filter(
    ([pattern]) =>
      (pattern as { cmd?: string })?.cmd === 'logistics.delivery.sale_quote',
  );
  expect(quoteCalls).toHaveLength(1);
  return quoteCalls[0][1] as Record<string, unknown>;
};

describe('6tGZzupr — GET /partner/tariff', () => {
  const saved = {
    engine: process.env.SALE_PRICING_ENGINE,
    ids: process.env.SALE_PRICING_ENGINE_MARKET_IDS,
  };

  beforeEach(() => {
    delete process.env.SALE_PRICING_ENGINE;
    delete process.env.SALE_PRICING_ENGINE_MARKET_IDS;
  });

  afterAll(() => {
    if (saved.engine === undefined) delete process.env.SALE_PRICING_ENGINE;
    else process.env.SALE_PRICING_ENGINE = saved.engine;
    if (saved.ids === undefined)
      delete process.env.SALE_PRICING_ENGINE_MARKET_IDS;
    else process.env.SALE_PRICING_ENGINE_MARKET_IDS = saved.ids;
  });

  describe('dvigatel narxi (o`lchov bilan)', () => {
    it('kalit o`chiq: quote dvigateldan, market_tariff profil (prod narxi o`zgarmaydi)', async () => {
      const logistics = logisticsOk();

      const { data } = await call(logistics, MEASURED);

      expect(salePayload(logistics)).toEqual({
        where_deliver: 'center',
        from_region_id: '5',
        from_district_id: '50',
        to_region_id: null,
        to_district_id: null,
        items: [
          {
            weight_kg: 3,
            length_cm: 30,
            width_cm: 20,
            height_cm: 40,
            quantity: 1,
          },
        ],
        express: false,
        pickup_count: 0,
      });
      expect(data).toMatchObject({
        elchi_market_id: '77',
        where_deliver: 'center',
        market_tariff: 10000,
        tariff_source: 'profile',
        estimated: false,
      });
      expect(data.quote).toMatchObject({
        tariffId: 'center',
        billableKg: 3,
        extraKg: 2,
        extra: 8000,
        total: 48000,
        days: [1, 2],
        cityRoute: false,
      });
    });

    it('kalit yoqiq: market_tariff = standart narx + qo`shimcha (sotuvdagi formula)', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = logisticsOk();

      const { data } = await call(logistics, MEASURED);

      expect(data.market_tariff).toBe(18000);
      expect(data.tariff_source).toBe('engine');
      expect(data.estimated).toBe(false);
    });

    it('kalit yoqiq: min_delivery_price floor sotuvdagidek qo`llanadi', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = logisticsOk({ min_delivery_price: 25000 });

      const { data } = await call(logistics, MEASURED);

      expect(data.market_tariff).toBe(25000);
    });

    it('kalit yoqiq, lekin market kelishuvli (weight_volume_pricing=false): profil', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = logisticsOk();

      const { data } = await call(
        logistics,
        MEASURED,
        market({ weight_volume_pricing: false }),
      );

      expect(data.market_tariff).toBe(10000);
      expect(data.tariff_source).toBe('profile');
    });

    it('canary: ro`yxatdan tashqari market — profil', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      process.env.SALE_PRICING_ENGINE_MARKET_IDS = '555';
      const logistics = logisticsOk();

      const { data } = await call(logistics, MEASURED);

      expect(data.market_tariff).toBe(10000);
      expect(data.tariff_source).toBe('profile');
    });

    it('region_id / district_id — yo`nalish (to_*), jo`natuvchi — market profili', async () => {
      const logistics = logisticsOk();

      await call(logistics, { ...MEASURED, region_id: '9', district_id: '90' });

      expect(salePayload(logistics)).toMatchObject({
        from_region_id: '5',
        from_district_id: '50',
        to_region_id: '9',
        to_district_id: '90',
      });
    });

    it('express va pickup hisobga uzatiladi, market_tariff ga QO`SHILMAYDI', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = logisticsOk({
        expressFee: 19200,
        pickupFee: 20000,
        total: 67000,
        totalWithPickup: 87000,
      });

      const { data } = await call(logistics, {
        ...MEASURED,
        express: 'true',
        pickup: 'true',
      });

      expect(salePayload(logistics)).toMatchObject({
        express: true,
        pickup_count: 1,
      });
      expect(data.quote).toMatchObject({
        expressFee: 19200,
        pickupFee: 20000,
        total: 67000,
        totalWithPickup: 87000,
      });
      // Sotuvda express/pickup market tarifiga kirmaydi (pickup alohida, B824gOu5).
      expect(data.market_tariff).toBe(18000);
    });

    it('faqat og`irlik: dvigatel estimated bersa javob ham estimated', async () => {
      const logistics = logisticsOk({
        estimated: true,
        missingDimensionItems: 1,
      });

      const { data } = await call(logistics, { weight_kg: '2.5' });

      expect(salePayload(logistics).items).toEqual([
        { weight_kg: 2.5, quantity: 1 },
      ]);
      expect(data.estimated).toBe(true);
    });

    it('javobda ichki id`lar yo`q (tarif qatori, sozlama)', async () => {
      const { data } = await call(logisticsOk(), MEASURED);

      const quote = data.quote as Record<string, unknown>;
      for (const key of ['tariff_row_id', 'settings_id', 'tariff']) {
        expect(quote).not.toHaveProperty(key);
      }
    });
  });

  describe('o`lchovsiz (estimated: true, baza tarif)', () => {
    it('⭐ eski hamkor so`rovi: logistics chaqirilmaydi, market_tariff AYNI', async () => {
      const logistics = jest.fn();

      const { data } = await call(logistics);

      expect(logistics).not.toHaveBeenCalled();
      expect(data).toEqual({
        elchi_market_id: '77',
        where_deliver: 'center',
        market_tariff: 10000,
        tariff_source: 'profile',
        estimated: true,
        quote: null,
      });
    });

    it('where_deliver berilmasa — eski sukut: address', async () => {
      const { data } = await controller(
        jest.fn(),
        identityOf(market()),
      ).getTariff('77', undefined, partnerReq);

      expect(data.where_deliver).toBe('address');
      expect(data.market_tariff).toBe(15000);
    });

    it('⭐ profilda tarif yo`q: tarif jadvali bazasi, jimgina 0 EMAS', async () => {
      const logistics = logisticsOk({
        estimated: true,
        unmeasuredItems: 1,
        billableKg: 0.1,
        extraKg: 0,
        extra: 0,
        total: 40000,
      });

      const { data } = await call(
        logistics,
        {},
        market({ tariff_center: null, tariff_home: null }),
      );

      expect(salePayload(logistics).items).toEqual([
        { product_id: null, quantity: 1 },
      ]);
      expect(data.market_tariff).toBe(40000);
      expect(data.market_tariff).not.toBe(0);
      expect(data.estimated).toBe(true);
    });

    it('profilda tarif yo`q va dvigatel javob bermasa: 503, jimgina 0 EMAS', async () => {
      const logistics = jest.fn(() =>
        throwError(() => ({ statusCode: 409, message: 'tarif yo`q' })),
      );

      await expect(
        call(logistics, {}, market({ tariff_center: null, tariff_home: null })),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('⭐ profilda ANIQ 0 (hamkor tarif bermagan): 0 qoladi, lekin jim emas — quote yonida', async () => {
      const logistics = logisticsOk({
        estimated: true,
        unmeasuredItems: 1,
        extra: 0,
        total: 40000,
      });

      const { data } = await call(logistics, {}, market({ tariff_center: 0 }));

      // Sotuvda ham 0 olinadi — prod narxi o'zgarmaydi.
      expect(data.market_tariff).toBe(0);
      expect(data.tariff_source).toBe('profile');
      expect(data.estimated).toBe(true);
      expect(data.quote).toMatchObject({ base: 40000, total: 40000 });
    });

    it('profilda ANIQ 0 va dvigatel javob bermasa: eski xulq (0), 503 EMAS', async () => {
      const logistics = jest.fn(() => throwError(() => new Error('down')));

      const { data } = await call(logistics, {}, market({ tariff_center: 0 }));

      expect(data.market_tariff).toBe(0);
      expect(data.estimated).toBe(true);
      expect(data.quote).toBeNull();
    });

    it('kalit yoqiq, o`lchovsiz: dvigatel ham bazani beradi (qo`shimcha 0)', async () => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = logisticsOk({
        estimated: true,
        unmeasuredItems: 1,
        extra: 0,
      });

      const { data } = await call(logistics);

      expect(data.market_tariff).toBe(10000);
      expect(data.estimated).toBe(true);
    });
  });

  describe('dvigatel javob bermasa (sotuvdagi kabi — to`xtamaydi)', () => {
    it.each([
      ['timeout / xizmat o`chiq', new Error('down')],
      ['faol tarif yo`q', { statusCode: 409, message: 'tarif yo`q' }],
    ])('%s: profil tarifi, estimated, quote null', async (_name, failure) => {
      process.env.SALE_PRICING_ENGINE = 'on';
      const logistics = jest.fn(() => throwError(() => failure));

      const { data } = await call(logistics, MEASURED);

      expect(data).toEqual({
        elchi_market_id: '77',
        where_deliver: 'center',
        market_tariff: 10000,
        tariff_source: 'profile',
        estimated: true,
        quote: null,
      });
    });

    it('logistics 400 (noto`g`ri kirish) — hamkorga 400', async () => {
      const logistics = jest.fn(() =>
        throwError(() => ({ statusCode: 400, message: 'noto`g`ri' })),
      );

      await expect(call(logistics, MEASURED)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('kirish tekshiruvi (400)', () => {
    it.each<[string, Record<string, unknown>]>([
      ['manfiy og`irlik', { weight_kg: '-1' }],
      ['nol og`irlik', { weight_kg: '0' }],
      ['son emas', { weight_kg: 'abc' }],
      ['ko`rsatkichli yozuv', { weight_kg: '1e2' }],
      ['4 kasr', { weight_kg: '1.1234' }],
      ['ikki marta berilgan', { weight_kg: ['1', '2'] }],
      ['kasrli o`lcham', { ...MEASURED, length_cm: '30.5' }],
      ['chala o`lcham', { length_cm: '30', width_cm: '20' }],
      ['chegaradan katta o`lcham', { ...MEASURED, height_cm: '1001' }],
      ['express noto`g`ri', { express: 'ha' }],
      ['pickup noto`g`ri', { pickup: '2' }],
      ['region_id son emas', { region_id: 'Toshkent' }],
      ['district_id son emas', { district_id: '1;2' }],
    ])('%s', async (_name, query) => {
      const logistics = logisticsOk();

      await expect(call(logistics, query)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(logistics).not.toHaveBeenCalled();
    });
  });

  describe('egalik (RBAC-13) o`zgarmagan', () => {
    it('begona market — 404, dvigatelga bormaydi', async () => {
      const logistics = logisticsOk();

      await expect(
        call(logistics, MEASURED, market({ username: 'mp8_shop' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(logistics).not.toHaveBeenCalled();
    });
  });

  it('mustaqil tarif ternary`si yo`q — yagona manba resolveOrderTariffDetailed', () => {
    const source = readFileSync(
      join(__dirname, 'partner-gateway.controller.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/tariff_center\s*\?\?/);
    expect(source).not.toMatch(/tariff_home\s*\?\?/);
    expect(source).toContain('resolveOrderTariffDetailed');
  });
});
