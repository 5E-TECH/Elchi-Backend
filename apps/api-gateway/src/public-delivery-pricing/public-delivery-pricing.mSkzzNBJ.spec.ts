import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Observable, from, throwError } from 'rxjs';
import request from 'supertest';
import {
  AllExceptionsFilter,
  computeDeliveryQuote,
  gatewayValidationSchema,
  RpcExceptionFilter,
} from '@app/common';
import { DeliveryPricingService } from '../../../logistics-service/src/delivery-pricing/delivery-pricing.service';
import { ClientIpThrottlerGuard } from '../auth/client-ip-throttler.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicDeliveryPricingController } from './public-delivery-pricing.controller';
import {
  PUBLIC_PRICING_THROTTLE,
  PublicPricingCache,
  publicPricingCacheTtlMs,
  publicPricingThrottleConfig,
  toLogisticsQuotePayload,
} from './public-delivery-pricing';

/**
 * mSkzzNBJ — ochiq kalkulyator: `POST /public/delivery-quote`,
 * `GET /public/delivery-tariffs`.
 *
 * DRIFT TESTI: so'rov HTTP → haqiqiy ValidationPipe → controller → soxta RMQ
 * mijozi → HAQIQIY logistics `DeliveryPricingService.quote` (soxta repo'lar)
 * → `computeDeliveryQuote` yo'lidan o'tadi. 13 oltin vektor (landing
 * `lib/pricing.test.ts`, `libs/common/src/pricing/delivery-pricing.spec.ts`
 * dagi AYNAN o'sha kirish/kutilgan sonlar) API javobida tekshiriladi, har biri
 * dvigatelning to'g'ridan-to'g'ri natijasi bilan ham solishtiriladi. Tarif
 * yoki formula biror joyda o'zgarsa — shu test yiqiladi.
 */

/** Landing hudud kodi → backend viloyat id'si (soxta `regions`). */
const REGION_IDS: Record<string, string> = {
  tsh: '1', // Toshkent shahri — is_city_zone
  tshv: '2', // Toshkent viloyati — "boshqa viloyat"
  sam: '6',
  qqr: '7',
  sur: '8',
  far: '9',
};
const REGIONS: Record<string, Record<string, unknown>> = {
  '1': { id: '1', name: 'Toshkent shahri', is_city_zone: true, logist_id: '5' },
  '2': { id: '2', name: 'Toshkent viloyati', is_city_zone: false },
  '6': { id: '6', name: 'Samarqand', is_city_zone: false },
  '7': { id: '7', name: "Qoraqalpog'iston", is_city_zone: false },
  '8': { id: '8', name: 'Surxondaryo', is_city_zone: false },
  '9': { id: '9', name: "Farg'ona", is_city_zone: false },
};

/** Landing `config/site.ts` TARIFFS — oltin vektorlar shu qiymatlarda. */
const LANDING_TARIFFS: Record<string, Record<string, unknown>> = {
  city: {
    id: '11',
    tariff_id: 'city',
    base_price: 35_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 1,
    valid_from: new Date('2026-10-08'),
    created_by: '1',
  },
  center: {
    id: '12',
    tariff_id: 'center',
    base_price: 40_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 2,
    valid_from: new Date('2026-10-08'),
    created_by: '1',
  },
  address: {
    id: '13',
    tariff_id: 'address',
    base_price: 60_000,
    extra_per_kg: 5_000,
    days_min: 2,
    days_max: 3,
    valid_from: new Date('2026-10-08'),
    created_by: '1',
  },
};
/** Landing EXTRAS + VOLUMETRIC_DIVISOR (hajm chegarasi yo'q — landing formulasi). */
const LANDING_SETTINGS: Record<string, unknown> = {
  id: '3',
  volumetric_divisor: 5_000,
  volumetric_from_kg: 0,
  first_kg_included: 1,
  min_billable_kg: 0.1,
  billable_step_kg: 0.1,
  round_to: 500,
  pickup_fee: 8_000,
  pickup_free_from_count: null,
  express_multiplier: 1.4,
  is_active: true,
  created_by: '1',
};
/** Prod faol sozlamasi (2026-10-26): pickup 20 000 / 10+ tekin, hajm ≥ 3 kg. */
const PROD_SETTINGS = {
  ...LANDING_SETTINGS,
  pickup_fee: 20_000,
  pickup_free_from_count: 10,
  volumetric_from_kg: 3,
};

interface Db {
  tariffs: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
}

/** Haqiqiy logistics servisi — DB o'rniga `db` obyekti. */
function buildLogistics(db: Db) {
  const regionRepo = {
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(REGIONS[id] ?? null),
    ),
  };
  const districtRepo = { findOne: jest.fn(() => Promise.resolve(null)) };
  const catalogClient = { send: jest.fn() };
  const service = new DeliveryPricingService(
    { manager: {} } as never,
    { manager: {} } as never,
    regionRepo as never,
    districtRepo as never,
    catalogClient as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
  jest
    .spyOn(service, 'findCurrentTariff')
    .mockImplementation((id: string) =>
      Promise.resolve((db.tariffs[id] as never) ?? null),
    );
  jest
    .spyOn(service, 'findActiveSettings')
    .mockImplementation(() => Promise.resolve(db.settings as never));
  return { service, catalogClient, regionRepo };
}

/** RMQ transporti kabi: RpcException → mijozga `getError()` obyekti. */
const viaRmq = (run: () => Promise<unknown>): Observable<unknown> =>
  from(
    run().catch((error: unknown) => {
      throw error instanceof RpcException ? error.getError() : error;
    }),
  );

interface Harness {
  app: INestApplication;
  db: Db;
  logistics: { send: jest.Mock };
  catalogClient: { send: jest.Mock };
}

async function createApp(options: { throttle?: boolean } = {}) {
  const db: Db = {
    tariffs: { ...LANDING_TARIFFS },
    settings: { ...LANDING_SETTINGS },
  };
  const { service, catalogClient } = buildLogistics(db);
  const logistics = {
    send: jest.fn(({ cmd }: { cmd: string }, payload: unknown) => {
      switch (cmd) {
        case 'logistics.delivery.quote':
          return viaRmq(() => service.quote(payload as never));
        case 'logistics.delivery.tariffs.find_all':
          return viaRmq(() =>
            Promise.resolve({
              statusCode: 200,
              message: 'success',
              data: {
                current: db.tariffs,
                versions: Object.values(db.tariffs).map((row) => ({
                  ...row,
                  is_current: true,
                })),
              },
            }),
          );
        case 'logistics.delivery.settings.get':
          return viaRmq(() =>
            Promise.resolve({
              statusCode: 200,
              message: 'success',
              data: db.settings,
            }),
          );
        case 'logistics.region.find_all':
          return viaRmq(() =>
            Promise.resolve({
              statusCode: 200,
              message: 'success',
              data: Object.values(REGIONS).map((row) => ({
                ...row,
                districts: [{ id: '100', name: 'Chilonzor' }],
              })),
            }),
          );
        default:
          return throwError(() => new Error(`kutilmagan cmd: ${cmd}`));
      }
    }),
  };

  const moduleRef = await Test.createTestingModule({
    imports: options.throttle
      ? [
          ThrottlerModule.forRoot({
            throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }],
          }),
        ]
      : [],
    controllers: [PublicDeliveryPricingController],
    providers: [
      { provide: 'LOGISTICS', useValue: logistics },
      // Prod'dagi default-deny JWT guard — @Public() bo'lmasa 401 bo'lardi.
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      ...(options.throttle
        ? [{ provide: APP_GUARD, useClass: ClientIpThrottlerGuard }]
        : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
  await app.init();
  return { app, db, logistics, catalogClient } satisfies Harness;
}

const http = (app: INestApplication) =>
  app.getHttpServer() as Parameters<typeof request>[0];

// ------------------------------------------------------- oltin vektorlar

interface LandingInput {
  from: string;
  to: string;
  delivery: 'center' | 'address';
  weight: number;
  length: number;
  width: number;
  height: number;
  express: boolean;
  pickup: boolean;
}

const BASE: LandingInput = {
  from: 'tsh',
  to: 'sam',
  delivery: 'center',
  weight: 1.2,
  length: 30,
  width: 22,
  height: 15,
  express: false,
  pickup: false,
};

/** Landing kirishi → ochiq so'rov tanasi (kalkulyator shakli). */
const bodyOf = (input: LandingInput) => ({
  from_region_id: REGION_IDS[input.from],
  to_region_id: REGION_IDS[input.to],
  where_deliver: input.delivery,
  weight_kg: input.weight,
  length_cm: input.length,
  width_cm: input.width,
  height_cm: input.height,
  express: input.express,
  pickup: input.pickup,
});

/** Dvigatel to'g'ridan-to'g'ri (o'sha tarif/sozlama bilan). */
const engineOf = (input: LandingInput, db: Db) => {
  const cityRoute =
    REGIONS[REGION_IDS[input.from]].is_city_zone === true &&
    REGIONS[REGION_IDS[input.to]].is_city_zone === true;
  const tariffId = cityRoute ? 'city' : input.delivery;
  return computeDeliveryQuote({
    items: [
      {
        weight_kg: input.weight,
        length_cm: input.length,
        width_cm: input.width,
        height_cm: input.height,
        volumetric_enabled: true,
        quantity: 1,
      },
    ],
    tariff: db.tariffs[tariffId] as never,
    settings: db.settings as never,
    express: input.express,
    pickupCount: input.pickup ? 1 : 0,
  });
};

describe('mSkzzNBJ — POST /public/delivery-quote: 13 oltin vektor (drift)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createApp();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  /**
   * API javobi → landing `Quote` maydon nomlari; har chaqiriqda dvigatelning
   * to'g'ridan-to'g'ri natijasi bilan AYNI ekani ham tekshiriladi.
   */
  const quote = async (input: LandingInput) => {
    const res = await request(http(h.app))
      .post('/public/delivery-quote')
      .send(bodyOf(input));
    expect(res.status).toBe(200);
    const q = res.body.data as Record<string, any>;
    const engine = engineOf(input, h.db);
    for (const key of [
      'tariffId',
      'base',
      'perExtraKg',
      'daysMin',
      'daysMax',
      'volumetricKg',
      'billableKg',
      'extraKg',
      'extra',
      'expressFee',
      'pickupFee',
      'total',
      'totalWithPickup',
    ] as const) {
      expect([key, q[key]]).toEqual([key, engine[key]]);
    }
    if (!input.pickup) expect(q.total).toBe(q.totalWithPickup);
    return {
      tariff: q.tariffId,
      base: q.base,
      perExtraKg: q.perExtraKg,
      days: q.days,
      volumetric: q.volumetricKg,
      billable: q.billableKg,
      extra: q.extra,
      expressFee: q.expressFee,
      pickupFee: q.pickupFee,
      total: q.totalWithPickup,
      orderTotal: q.total,
      cityRoute: q.cityRoute,
      volumetricApplied: q.volumetricApplied,
    };
  };

  it('1. Toshkent shahri ichida — har doim shahar tarifi', async () => {
    for (const delivery of ['center', 'address'] as const) {
      const q = await quote({ ...BASE, to: 'tsh', delivery });
      expect(q.tariff).toBe('city');
      expect(q.cityRoute).toBe(true);
    }
  });

  it("2. Toshkent viloyati 'boshqa viloyat' hisoblanadi", async () => {
    const center = await quote({ ...BASE, to: 'tshv' });
    const address = await quote({ ...BASE, to: 'tshv', delivery: 'address' });
    expect(center.cityRoute).toBe(false);
    expect(center.tariff).toBe('center');
    expect(address.tariff).toBe('address');
  });

  it('3. shahar tashqarisida narxni yetkazish turi belgilaydi', async () => {
    expect((await quote(BASE)).tariff).toBe('center');
    expect((await quote({ ...BASE, delivery: 'address' })).tariff).toBe(
      'address',
    );
    expect(
      (await quote({ ...BASE, from: 'qqr', to: 'tsh', delivery: 'address' }))
        .tariff,
    ).toBe('address');
    expect((await quote({ ...BASE, from: 'sur', to: 'far' })).tariff).toBe(
      'center',
    );
  });

  it('4. viloyat markazigacha standart holat', async () => {
    const q = await quote(BASE);
    expect(q.tariff).toBe('center');
    expect(q.volumetric).toBeCloseTo(1.98, 5);
    expect(q.billable).toBe(2);
    expect(q.base).toBe(40_000);
    expect(q.perExtraKg).toBe(4_000);
    expect(q.extra).toBe(4_000);
    expect(q.total).toBe(44_000);
    expect(q.days).toEqual([1, 2]);
  });

  it('5. manzilgacha tarifi 60 000 dan va har kg uchun 5 000', async () => {
    const q = await quote({ ...BASE, delivery: 'address' });
    expect(q.tariff).toBe('address');
    expect(q.base).toBe(60_000);
    expect(q.perExtraKg).toBe(5_000);
    expect(q.extra).toBe(5_000);
    expect(q.total).toBe(65_000);
  });

  it("6. Toshkent shahri 35 000 dan, har qo'shimcha kg 4 000", async () => {
    const q = await quote({
      ...BASE,
      to: 'tsh',
      weight: 3,
      length: 10,
      width: 10,
      height: 10,
    });
    expect(q.tariff).toBe('city');
    expect(q.base).toBe(35_000);
    expect(q.perExtraKg).toBe(4_000);
    expect(q.extra).toBe(8_000);
    expect(q.total).toBe(43_000);
  });

  it("7. hajmli vazn haqiqiy vazndan katta bo'lsa, o'sha hisoblanadi", async () => {
    const q = await quote({
      ...BASE,
      weight: 2,
      length: 60,
      width: 40,
      height: 30,
    });
    expect(q.volumetric).toBeCloseTo(14.4, 5);
    expect(q.billable).toBe(14.4);
    expect(q.extra).toBe(14 * 4_000);
  });

  it("8. haqiqiy vazn kattaroq bo'lsa, hajmli vazn e'tiborga olinmaydi", async () => {
    const q = await quote({
      ...BASE,
      weight: 9,
      length: 10,
      width: 10,
      height: 10,
    });
    expect(q.volumetric).toBeCloseTo(0.2, 5);
    expect(q.billable).toBe(9);
  });

  it("9. 1 kg gacha jo'natmada ustama yo'q; aniq 1.0 kg da qo'shimcha kg yo'q", async () => {
    const small = await quote({
      ...BASE,
      to: 'tsh',
      weight: 0.4,
      length: 10,
      width: 10,
      height: 10,
    });
    expect(small.billable).toBe(0.4);
    expect(small.extra).toBe(0);
    expect(small.total).toBe(35_000);
    const exact = await quote({
      ...BASE,
      to: 'tsh',
      weight: 1,
      length: 10,
      width: 10,
      height: 10,
    });
    expect(exact.billable).toBe(1);
    expect(exact.extra).toBe(0);
  });

  it('10. eng kichik hisoblanadigan vazn — 0.1 kg', async () => {
    const q = await quote({
      ...BASE,
      weight: 0.01,
      length: 1,
      width: 1,
      height: 1,
    });
    expect(q.billable).toBe(0.1);
  });

  it('11. tezkor yetkazish asosiy summaga 1.4 koeffitsient qo`llaydi', async () => {
    const q = await quote({ ...BASE, express: true });
    expect(q.expressFee).toBeCloseTo(17_600, 5);
    expect(q.total).toBe(61_500);
  });

  it('12. pickup haqi qo`shiladi (buyurtma narxiga — yo`q)', async () => {
    const q = await quote({ ...BASE, pickup: true });
    expect(q.pickupFee).toBe(8_000);
    expect(q.total).toBe(52_000);
    expect(q.orderTotal).toBe(44_000);
  });

  it('13. yakuniy summa har doim 500 ga karrali; manzilgacha > markazgacha', async () => {
    for (const weight of [0.3, 1.7, 2.4, 5.5, 12.9]) {
      for (const express of [false, true]) {
        for (const delivery of ['center', 'address'] as const) {
          const q = await quote({
            ...BASE,
            weight,
            express,
            delivery,
            pickup: true,
          });
          expect(q.total % 500).toBe(0);
          expect(q.orderTotal % 500).toBe(0);
        }
      }
    }
    for (const weight of [0.5, 1, 4.2, 11]) {
      const center = await quote({ ...BASE, weight, delivery: 'center' });
      const address = await quote({ ...BASE, weight, delivery: 'address' });
      expect(address.total).toBeGreaterThan(center.total);
    }
  });

  it('tarif qiymati o`zgarsa javob ham o`zgaradi — oltin son bilan farq ushlanadi', async () => {
    const before = await quote({ ...BASE, weight: 4.4 });
    h.db.tariffs.center = { ...LANDING_TARIFFS.center, base_price: 41_000 };
    try {
      // Kesh kaliti boshqa (og'irlik boshqa) — yangi tarif darhol ko'rinadi.
      const after = await quote({ ...BASE, weight: 4.45 });
      expect(after.base).toBe(41_000);
      expect(after.total).not.toBe(before.total);
    } finally {
      h.db.tariffs.center = LANDING_TARIFFS.center;
    }
  });

  it('prod sozlamasi (hajm ≥ 3 kg, pickup 20 000) — dvigatel bilan AYNI', async () => {
    h.db.settings = { ...PROD_SETTINGS };
    try {
      // 1.98 kg hajm < 3 — hajm hisobga olinmaydi, hisob vazni 1.2 kg.
      // (Kesh: oldingi testlardagi kirishdan farqli og'irlik.)
      const small = await quote({ ...BASE, weight: 1.19, pickup: true });
      expect(small.billable).toBe(1.2);
      expect(small.orderTotal).toBe(44_000);
      expect(small.pickupFee).toBe(20_000);
      expect(small.total).toBe(64_000);
      // 14.4 kg hajm ≥ 3 — hajm qo'llanadi.
      const big = await quote({
        ...BASE,
        weight: 2.01,
        length: 60,
        width: 40,
        height: 30,
        express: true,
      });
      expect(big.billable).toBe(14.4);
      expect(big.volumetricApplied).toBe(true);
    } finally {
      h.db.settings = { ...LANDING_SETTINGS };
    }
  });
});

describe('mSkzzNBJ — POST /public/delivery-quote: kirish, javob, kesh', () => {
  let h: Harness;
  const BODY = bodyOf(BASE);
  const post = (body: unknown) =>
    request(http(h.app))
      .post('/public/delivery-quote')
      .send(body as object);

  beforeAll(async () => {
    h = await createApp();
  });
  afterAll(async () => {
    await h?.app.close();
  });
  beforeEach(() => {
    h.logistics.send.mockClear();
  });

  it('tokensiz ishlaydi (@Public) va faqat hisobni qaytaradi — ichki maydon yo`q', async () => {
    const res = await post({ ...BODY, weight_kg: 1.21 });
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.total).toBe(44_000);
    expect(data.days).toEqual([1, 2]);
    for (const key of [
      'tariff',
      'settings_id',
      'route',
      'unmeasured_product_ids',
      'missing_dimension_product_ids',
      'unmeasuredItems',
    ]) {
      expect(data).not.toHaveProperty(key);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('valid_from');
    expect(text).not.toContain('created_by');
  });

  it('logistics payload — AYNAN sanab olingan maydonlar: product_id/requester yo`q, pickup → pickup_count 1', async () => {
    await post({ ...BODY, weight_kg: 1.22, pickup: true });
    expect(h.logistics.send).toHaveBeenCalledTimes(1);
    const [pattern, payload] = h.logistics.send.mock.calls[0] as [
      { cmd: string },
      Record<string, unknown>,
    ];
    expect(pattern).toEqual({ cmd: 'logistics.delivery.quote' });
    expect(payload).toEqual({
      items: [{ weight_kg: 1.22, length_cm: 30, width_cm: 22, height_cm: 15 }],
      from_region_id: '1',
      to_region_id: '6',
      where_deliver: 'center',
      express: false,
      pickup_count: 1,
    });
    expect(h.catalogClient.send).not.toHaveBeenCalled();
  });

  it('items[] — bitta jo`natma (og`irlik/hajm qo`shiladi), quantity bilan', async () => {
    const res = await post({
      from_region_id: 1,
      to_region_id: 6,
      where_deliver: 'center',
      items: [
        {
          weight_kg: 1.2,
          length_cm: 30,
          width_cm: 22,
          height_cm: 15,
          quantity: 2,
        },
        { weight_kg: 0.5, volumetric_enabled: false },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.actualKg).toBe(2.9);
    expect(res.body.data.missingDimensionItems).toBe(0);
  });

  it('bir xil kirish keshdan — logistics bir marta; xato keshlanmaydi', async () => {
    const body = { ...BODY, weight_kg: 1.23 };
    const first = await post(body);
    const second = await post(body);
    expect(second.body).toEqual(first.body);
    expect(h.logistics.send).toHaveBeenCalledTimes(1);

    await post({ ...body, to_region_id: '999' });
    await post({ ...body, to_region_id: '999' });
    expect(h.logistics.send).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['manfiy og`irlik', { ...BODY, weight_kg: -1 }],
    ['nol og`irlik', { ...BODY, weight_kg: 0 }],
    ['manfiy uzunlik', { ...BODY, length_cm: -5 }],
    ['kasrli o`lcham', { ...BODY, width_cm: 2.5 }],
    ['L/W/H to`liq emas', { ...BODY, height_cm: undefined }],
    ['og`irlik yo`q', { ...BODY, weight_kg: undefined }],
    ['og`irlik satr', { ...BODY, weight_kg: 'abc' }],
    ['product_id (yuqori daraja)', { ...BODY, product_id: '42' }],
    [
      'product_id (items ichida)',
      {
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
        items: [{ product_id: '42' }],
      },
    ],
    ['tuman id', { ...BODY, to_district_id: '60' }],
    ['requester', { ...BODY, requester: { id: '1', roles: ['superadmin'] } }],
    ['raqamsiz viloyat id', { ...BODY, to_region_id: 'sam' }],
    ['viloyat id yo`q', { ...BODY, from_region_id: undefined }],
    ['noto`g`ri where_deliver', { ...BODY, where_deliver: 'moon' }],
    ['items + weight_kg birga', { ...BODY, items: [{ weight_kg: 1 }] }],
    [
      'bo`sh items',
      {
        ...BODY,
        weight_kg: undefined,
        length_cm: undefined,
        width_cm: undefined,
        height_cm: undefined,
        items: [],
      },
    ],
    [
      '20 dan ko`p element',
      {
        from_region_id: '1',
        to_region_id: '6',
        where_deliver: 'center',
        items: Array.from({ length: 21 }, () => ({ weight_kg: 1 })),
      },
    ],
    ['pickup satr', { ...BODY, pickup: 'yes' }],
  ])('%s → 400 (500 emas), logistics chaqirilmaydi', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.logistics.send).not.toHaveBeenCalled();
  });

  it('yo`q viloyat id → 400 (logistics 404 → 400), 500 emas', async () => {
    const res = await post({ ...BODY, weight_kg: 1.24, to_region_id: '999' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Viloyat topilmadi (to_region_id)');
  });

  it('faol tarif yo`q → 409, ichki tafsilotsiz', async () => {
    const saved = h.db.tariffs.address;
    delete h.db.tariffs.address;
    try {
      const res = await post({
        ...BODY,
        weight_kg: 1.25,
        where_deliver: 'address',
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Yetkazish tarifi hozircha sozlanmagan');
    } finally {
      h.db.tariffs.address = saved;
    }
  });
});

describe('mSkzzNBJ — GET /public/delivery-tariffs', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createApp();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('tokensiz: hozirgi tariflar + sozlamalar (pickup qoidasi) + viloyatlar; tarix/id/created_by yo`q; keshlanadi', async () => {
    h.db.settings = { ...PROD_SETTINGS };
    const res = await request(http(h.app)).get('/public/delivery-tariffs');
    expect(res.status).toBe(200);
    expect(res.body.data.tariffs).toEqual({
      city: { base_price: 35000, extra_per_kg: 4000, days_min: 1, days_max: 1 },
      center: {
        base_price: 40000,
        extra_per_kg: 4000,
        days_min: 1,
        days_max: 2,
      },
      address: {
        base_price: 60000,
        extra_per_kg: 5000,
        days_min: 2,
        days_max: 3,
      },
    });
    expect(res.body.data.settings).toEqual({
      volumetric_divisor: 5000,
      volumetric_from_kg: 3,
      first_kg_included: 1,
      min_billable_kg: 0.1,
      billable_step_kg: 0.1,
      round_to: 500,
      pickup_fee: 20000,
      pickup_free_from_count: 10,
      express_multiplier: 1.4,
    });
    expect(res.body.data.regions).toContainEqual({
      id: '1',
      name: 'Toshkent shahri',
      is_city_zone: true,
    });
    expect(res.body.data.regions).toHaveLength(6);
    const text = JSON.stringify(res.body);
    for (const leak of [
      'versions',
      'created_by',
      'valid_from',
      'is_current',
      'is_active',
      'logist_id',
      'districts',
      '"id":"11"', // tarif qatori id'si (viloyat id'si — ochiq, kalkulyator kirishi)
    ]) {
      expect(text).not.toContain(leak);
    }

    const calls = h.logistics.send.mock.calls.length;
    await request(http(h.app)).get('/public/delivery-tariffs').expect(200);
    expect(h.logistics.send.mock.calls.length).toBe(calls);
  });
});

describe('mSkzzNBJ — per-IP rate limit (ClientIpThrottlerGuard)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createApp({ throttle: true });
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it(`${PUBLIC_PRICING_THROTTLE.default.limit}/daqiqa dan keyin 429; boshqa IP — o'z hisoblagichi`, async () => {
    const limit = PUBLIC_PRICING_THROTTLE.default.limit;
    const hit = (ip: string) =>
      request(http(h.app))
        .post('/public/delivery-quote')
        .set('CF-Connecting-IP', ip)
        .send(bodyOf(BASE));
    for (let i = 0; i < limit; i += 1) {
      expect((await hit('203.0.113.7')).status).toBe(200);
    }
    expect((await hit('203.0.113.7')).status).toBe(429);
    expect((await hit('203.0.113.8')).status).toBe(200);
    // Kesh: hammasi bir xil kirish — logistics bir marta.
    expect(h.logistics.send).toHaveBeenCalledTimes(1);
  });

  it('GET /public/delivery-tariffs ham cheklangan', async () => {
    const limit = PUBLIC_PRICING_THROTTLE.default.limit;
    const hit = () =>
      request(http(h.app))
        .get('/public/delivery-tariffs')
        .set('CF-Connecting-IP', '198.51.100.1');
    for (let i = 0; i < limit; i += 1) expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});

describe('mSkzzNBJ — sof yordamchilar', () => {
  it('throttle: sukut 30/60 s, global limitdan yuqori emas, env bilan', () => {
    expect(publicPricingThrottleConfig({})).toEqual({
      default: { limit: 30, ttl: 60_000 },
    });
    expect(
      publicPricingThrottleConfig({
        PUBLIC_PRICING_THROTTLE_LIMIT: '20',
        PUBLIC_PRICING_THROTTLE_TTL_MS: '30000',
      }),
    ).toEqual({ default: { limit: 20, ttl: 30_000 } });
    expect(
      publicPricingThrottleConfig({
        THROTTLE_LIMIT: '10',
        PUBLIC_PRICING_THROTTLE_LIMIT: '100',
      }).default.limit,
    ).toBe(10);
    for (const raw of ['', 'abc', '0', '-5']) {
      expect(
        publicPricingThrottleConfig({ PUBLIC_PRICING_THROTTLE_LIMIT: raw })
          .default.limit,
      ).toBe(30);
    }
  });

  it('kesh TTL: sukut 30 s, 0 — o`chiq, ko`pi bilan 10 daqiqa', () => {
    expect(publicPricingCacheTtlMs({})).toBe(30_000);
    expect(publicPricingCacheTtlMs({ PUBLIC_PRICING_CACHE_TTL_MS: '0' })).toBe(
      0,
    );
    expect(
      publicPricingCacheTtlMs({ PUBLIC_PRICING_CACHE_TTL_MS: '9999999' }),
    ).toBe(600_000);
    expect(publicPricingCacheTtlMs({ PUBLIC_PRICING_CACHE_TTL_MS: 'x' })).toBe(
      30_000,
    );
  });

  it('PublicPricingCache: TTL, parallel so`rov bitta yuklash, xato keshlanmaydi, hajm cheklangan', async () => {
    let now = 1000;
    const cache = new PublicPricingCache(100, 2, () => now);
    const load = jest.fn(() => Promise.resolve('v'));
    await Promise.all([cache.getOrLoad('a', load), cache.getOrLoad('a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    now += 101;
    await cache.getOrLoad('a', load);
    expect(load).toHaveBeenCalledTimes(2);

    const failing = jest.fn(() => Promise.reject(new Error('x')));
    await expect(cache.getOrLoad('b', failing)).rejects.toThrow('x');
    await expect(cache.getOrLoad('b', failing)).rejects.toThrow('x');
    expect(failing).toHaveBeenCalledTimes(2);

    await cache.getOrLoad('c', load);
    await cache.getOrLoad('d', load);
    expect(cache.size).toBe(2);

    const off = new PublicPricingCache(0, 10);
    await off.getOrLoad('a', load);
    await off.getOrLoad('a', load);
    expect(off.size).toBe(0);
  });

  it('toLogisticsQuotePayload: null/undefined maydonlar tushib qoladi, tartib barqaror', () => {
    expect(
      toLogisticsQuotePayload({
        to_region_id: '6',
        from_region_id: '1',
        where_deliver: 'address',
        weight_kg: 2,
        volumetric_enabled: false,
        express: true,
      }),
    ).toEqual({
      items: [{ weight_kg: 2, volumetric_enabled: false }],
      from_region_id: '1',
      to_region_id: '6',
      where_deliver: 'address',
      express: true,
      pickup_count: 0,
    });
  });

  it('gatewayValidationSchema: PUBLIC_PRICING_* sukutlari kod bilan AYNI, bo`sh qiymat boot`ni yiqitmaydi', () => {
    const { error, value } = gatewayValidationSchema.validate(
      {
        PUBLIC_PRICING_THROTTLE_LIMIT: '',
        PUBLIC_PRICING_THROTTLE_TTL_MS: '',
        PUBLIC_PRICING_CACHE_TTL_MS: '',
      },
      { abortEarly: false, allowUnknown: true },
    );
    const own = (error?.details ?? []).filter((d) =>
      String(d.path[0]).startsWith('PUBLIC_PRICING_'),
    );
    expect(own).toEqual([]);
    expect(value.PUBLIC_PRICING_THROTTLE_LIMIT).toBe(30);
    expect(value.PUBLIC_PRICING_CACHE_TTL_MS).toBe(30_000);
  });
});
