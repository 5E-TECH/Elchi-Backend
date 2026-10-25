import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import { DeliveryPricingGatewayController } from './delivery-pricing-gateway.controller';

/**
 * DAqXPeSy — yetkazish narxi gateway'i: HAQIQIY RolesGuard + main.ts dagi
 * ValidationPipe (`whitelist + forbidNonWhitelisted + transform`).
 * JwtAuthGuard o'rniga test guard: `x-test-user` JSON → `req.user`.
 */
describe('DAqXPeSy — /delivery/* gateway', () => {
  let app: INestApplication;
  let reply: (pattern: { cmd: string }) => Observable<unknown>;
  const logistics = {
    send: jest.fn((...args: [{ cmd: string }, unknown]) => reply(args[0])),
  };
  const auditEnrichment = {
    resolveUserNames: jest.fn((ids: Iterable<unknown>) =>
      Promise.resolve(
        new Map(
          [...ids]
            .filter((id) => id === '1')
            .map((id) => [String(id), 'Shodiyor Ergashev'] as const),
        ),
      ),
    ),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roles: string[], sub = '21') => ({
    'x-test-user': JSON.stringify({ sub, roles }),
  });

  const QUOTE_BODY = {
    items: [{ weight_kg: 1.2, length_cm: 30, width_cm: 22, height_cm: 15 }],
    from_region_id: '1',
    to_district_id: '77',
    where_deliver: 'center',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DeliveryPricingGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: logistics },
        { provide: AuditEnrichmentService, useValue: auditEnrichment },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          const raw = req.headers['x-test-user'];
          if (raw) req.user = JSON.parse(String(raw));
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    logistics.send.mockClear();
    reply = () => of({ statusCode: 200, message: 'success', data: { ok: 1 } });
  });

  describe('rollar (dekorator metadata — openapi x-roles manbai)', () => {
    const rolesOf = (method: keyof DeliveryPricingGatewayController) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(
          DeliveryPricingGatewayController.prototype,
          method,
        )?.value,
      ) as string[];

    it('quote — xodimlar + MARKET; market_operator/kuryer/mijoz yo`q', () => {
      expect([...rolesOf('quote')].sort()).toEqual(
        [
          'admin',
          'branch',
          'logist',
          'manager',
          'market',
          'operator',
          'registrator',
          'superadmin',
        ].sort(),
      );
    });

    it.each([
      'listTariffs',
      'createTariff',
      'getSettings',
      'updateSettings',
    ] as const)('%s — faqat superadmin va admin', (method) => {
      expect(rolesOf(method)).toEqual(['superadmin', 'admin']);
    });
  });

  describe('POST /delivery/quote', () => {
    it('200 — DTO va so`rovchi logistics.delivery.quote ga uzatiladi', async () => {
      const res = await request(http())
        .post('/delivery/quote')
        .set(as(['market'], '501'))
        .send({
          ...QUOTE_BODY,
          items: [
            ...QUOTE_BODY.items,
            { product_id: 42, quantity: 3 },
            { weight_kg: 2, volumetric_enabled: false },
          ],
          to_district_id: 77,
          express: true,
          pickup_count: 2,
        });
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledTimes(1);
      const [pattern, payload] = logistics.send.mock.calls[0];
      expect(pattern).toEqual({ cmd: 'logistics.delivery.quote' });
      expect(payload).toEqual({
        items: [
          { weight_kg: 1.2, length_cm: 30, width_cm: 22, height_cm: 15 },
          { product_id: '42', quantity: 3 },
          { weight_kg: 2, volumetric_enabled: false },
        ],
        from_region_id: '1',
        to_district_id: '77',
        where_deliver: 'center',
        express: true,
        pickup_count: 2,
        requester: { id: '501', roles: ['market'] },
      });
    });

    it.each(['courier', 'market_operator', 'customer', 'investor'])(
      '%s → 403, logistics chaqirilmaydi',
      async (role) => {
        const res = await request(http())
          .post('/delivery/quote')
          .set(as([role]))
          .send(QUOTE_BODY);
        expect(res.status).toBe(403);
        expect(logistics.send).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Record<string, unknown>]>([
      [
        "noma'lum ustki maydon (total_price)",
        { ...QUOTE_BODY, total_price: 1 },
      ],
      [
        "noma'lum ichki maydon (items[].price)",
        { ...QUOTE_BODY, items: [{ weight_kg: 1, price: 5 }] },
      ],
      ['items bo`sh', { ...QUOTE_BODY, items: [] }],
      ['items yo`q', { where_deliver: 'center', from_region_id: '1' }],
      ['where_deliver noto`g`ri', { ...QUOTE_BODY, where_deliver: 'city' }],
      [
        'product_id ham, weight_kg ham yo`q',
        { ...QUOTE_BODY, items: [{ quantity: 2 }] },
      ],
      [
        'L/W/H chala (faqat length_cm)',
        { ...QUOTE_BODY, items: [{ weight_kg: 1, length_cm: 10 }] },
      ],
      ['weight_kg 4 kasr', { ...QUOTE_BODY, items: [{ weight_kg: 1.2345 }] }],
      ['weight_kg 0', { ...QUOTE_BODY, items: [{ weight_kg: 0 }] }],
      [
        'o`lcham kasr',
        {
          ...QUOTE_BODY,
          items: [{ weight_kg: 1, length_cm: 1.5, width_cm: 1, height_cm: 1 }],
        },
      ],
      ['quantity 0', { ...QUOTE_BODY, items: [{ weight_kg: 1, quantity: 0 }] }],
      ['region id raqam emas', { ...QUOTE_BODY, from_region_id: 'abc' }],
      ['pickup_count manfiy', { ...QUOTE_BODY, pickup_count: -1 }],
      ['express satr', { ...QUOTE_BODY, express: 'yes' }],
    ])('400 — %s', async (_name, body) => {
      const res = await request(http())
        .post('/delivery/quote')
        .set(as(['admin']))
        .send(body);
      expect(res.status).toBe(400);
      expect(logistics.send).not.toHaveBeenCalled();
    });

    it('504 — logistics javob bermasa', async () => {
      reply = () => throwError(() => new TimeoutError());
      const res = await request(http())
        .post('/delivery/quote')
        .set(as(['admin']))
        .send(QUOTE_BODY);
      expect(res.status).toBe(504);
    });
  });

  describe('admin: tariflar va sozlamalar', () => {
    const TARIFF = {
      tariff_id: 'center',
      base_price: 42000,
      extra_per_kg: 4500,
      days_min: 1,
      days_max: 2,
    };

    it.each(['manager', 'registrator', 'market', 'operator', 'logist'])(
      '%s → 403 (GET/POST tariffs, GET/PATCH pricing-settings)',
      async (role) => {
        const calls = [
          () =>
            request(http())
              .get('/delivery/tariffs')
              .set(as([role])),
          () =>
            request(http())
              .post('/delivery/tariffs')
              .set(as([role]))
              .send(TARIFF),
          () =>
            request(http())
              .get('/delivery/pricing-settings')
              .set(as([role])),
          () =>
            request(http())
              .patch('/delivery/pricing-settings')
              .set(as([role]))
              .send({ round_to: 1000 }),
          () =>
            request(http())
              .get('/delivery/pricing-settings/history')
              .set(as([role])),
        ];
        for (const call of calls) {
          expect((await call()).status).toBe(403);
        }
        expect(logistics.send).not.toHaveBeenCalled();
      },
    );

    it('GET /delivery/tariffs — filtr va limit uzatiladi', async () => {
      const res = await request(http())
        .get('/delivery/tariffs?tariff_id=city&limit=20')
        .set(as(['admin']));
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.tariffs.find_all' },
        { tariff_id: 'city', limit: 20 },
      );
    });

    it('GET /delivery/tariffs — tarix va joriy qatorlarga created_by_name (47WFHzlx)', async () => {
      reply = () =>
        of({
          statusCode: 200,
          message: 'ok',
          data: {
            current: { city: { id: '1', created_by: '1' }, center: null },
            versions: [
              { id: '3', created_by: '1' },
              { id: '2', created_by: '77' },
              { id: '1', created_by: null },
            ],
          },
        });
      const res = await request(http())
        .get('/delivery/tariffs')
        .set(as(['admin']));
      expect(res.status).toBe(200);
      expect(
        res.body.data.versions.map(
          (v: { created_by_name: unknown }) => v.created_by_name,
        ),
      ).toEqual(['Shodiyor Ergashev', null, null]);
      expect(res.body.data.current.city.created_by_name).toBe(
        'Shodiyor Ergashev',
      );
      expect(res.body.data.current.center).toBeNull();
    });

    it('GET /delivery/tariffs — identity xatosi javobni buzmaydi (ism null)', async () => {
      auditEnrichment.resolveUserNames.mockRejectedValueOnce(new Error('down'));
      reply = () =>
        of({
          statusCode: 200,
          message: 'ok',
          data: { current: {}, versions: [{ id: '3', created_by: '1' }] },
        });
      const res = await request(http())
        .get('/delivery/tariffs')
        .set(as(['superadmin']));
      expect(res.status).toBe(200);
      expect(res.body.data.versions[0].created_by_name).toBeNull();
    });

    it('GET /delivery/pricing-settings/history — limit uzatiladi, ism qo`shiladi', async () => {
      reply = () =>
        of({
          statusCode: 200,
          message: 'ok',
          data: {
            versions: [
              {
                id: '2',
                first_kg_included: 2,
                is_active: true,
                created_by: '1',
              },
              {
                id: '1',
                first_kg_included: 1,
                is_active: false,
                created_by: null,
              },
            ],
          },
        });
      const res = await request(http())
        .get('/delivery/pricing-settings/history?limit=10')
        .set(as(['admin']));
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.settings.history' },
        { limit: 10 },
      );
      expect(
        res.body.data.versions.map(
          (v: { created_by_name: unknown }) => v.created_by_name,
        ),
      ).toEqual(['Shodiyor Ergashev', null]);
    });

    it('POST /delivery/tariffs — yangi versiya, so`rovchi bilan', async () => {
      reply = () => of({ statusCode: 201, message: 'ok', data: { id: '9' } });
      const res = await request(http())
        .post('/delivery/tariffs')
        .set(as(['superadmin'], '1'))
        .send({ ...TARIFF, valid_from: '2026-11-01T00:00:00+05:00' });
      expect(res.status).toBe(201);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.tariffs.create' },
        {
          dto: { ...TARIFF, valid_from: '2026-11-01T00:00:00+05:00' },
          requester: { id: '1', roles: ['superadmin'] },
        },
      );
    });

    it.each<[string, Record<string, unknown>]>([
      ['tariff_id noto`g`ri', { ...TARIFF, tariff_id: 'express' }],
      ['base_price 3 kasr', { ...TARIFF, base_price: 1.005 }],
      ['extra_per_kg manfiy', { ...TARIFF, extra_per_kg: -1 }],
      ['base_price satr', { ...TARIFF, base_price: '40000' }],
      ['days_min yo`q', { ...TARIFF, days_min: undefined }],
      ['valid_from sana emas', { ...TARIFF, valid_from: 'ertaga' }],
      ["noma'lum maydon (is_active)", { ...TARIFF, is_active: false }],
    ])('POST /delivery/tariffs 400 — %s', async (_name, body) => {
      const res = await request(http())
        .post('/delivery/tariffs')
        .set(as(['admin']))
        .send(body);
      expect(res.status).toBe(400);
      expect(logistics.send).not.toHaveBeenCalled();
    });

    it('GET /delivery/pricing-settings', async () => {
      const res = await request(http())
        .get('/delivery/pricing-settings')
        .set(as(['admin']));
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.settings.get' },
        {},
      );
    });

    it('PATCH /delivery/pricing-settings — qisman, null pickup_free_from_count', async () => {
      const res = await request(http())
        .patch('/delivery/pricing-settings')
        .set(as(['admin'], '7'))
        .send({ pickup_fee: 20000, pickup_free_from_count: null });
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.settings.update' },
        {
          dto: { pickup_fee: 20000, pickup_free_from_count: null },
          requester: { id: '7', roles: ['admin'] },
        },
      );
    });

    it('PATCH /delivery/pricing-settings — volumetric_from_kg 2,5 (AQ9lkgVB)', async () => {
      const res = await request(http())
        .patch('/delivery/pricing-settings')
        .set(as(['superadmin'], '1'))
        .send({ volumetric_from_kg: 2.5 });
      expect(res.status).toBe(200);
      expect(logistics.send).toHaveBeenCalledWith(
        { cmd: 'logistics.delivery.settings.update' },
        {
          dto: { volumetric_from_kg: 2.5 },
          requester: { id: '1', roles: ['superadmin'] },
        },
      );
      // 0 ham ruxsat (chegara yo'q — hajm har doim).
      const zero = await request(http())
        .patch('/delivery/pricing-settings')
        .set(as(['admin']))
        .send({ volumetric_from_kg: 0 });
      expect(zero.status).toBe(200);
    });

    it.each<[string, unknown, string]>([
      ['−1', -1, "volumetric_from_kg 0 dan kichik bo'lmasligi kerak"],
      ['1001', 1001, 'volumetric_from_kg 1000 dan oshmasligi kerak'],
      ['4 kasr', 2.5001, "volumetric_from_kg — ko'pi bilan 3 kasrli son (kg)"],
      ['satr', '3', 'volumetric_from_kg — son (kg)'],
    ])(
      'PATCH /delivery/pricing-settings 400 — volumetric_from_kg %s (AQ9lkgVB)',
      async (_name, value, message) => {
        const res = await request(http())
          .patch('/delivery/pricing-settings')
          .set(as(['superadmin']))
          .send({ volumetric_from_kg: value });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain(message);
        expect(logistics.send).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Record<string, unknown>]>([
      ['express_multiplier < 1', { express_multiplier: 0.9 }],
      ['volumetric_divisor 0', { volumetric_divisor: 0 }],
      ['volumetric_divisor kasr', { volumetric_divisor: 5000.5 }],
      ['round_to 0', { round_to: 0 }],
      ['min_billable_kg 0', { min_billable_kg: 0 }],
      ['billable_step_kg 4 kasr', { billable_step_kg: 0.0001 }],
      ['pickup_free_from_count 0', { pickup_free_from_count: 0 }],
      ["noma'lum maydon (is_active)", { is_active: false }],
    ])('PATCH /delivery/pricing-settings 400 — %s', async (_name, body) => {
      const res = await request(http())
        .patch('/delivery/pricing-settings')
        .set(as(['superadmin']))
        .send(body);
      expect(res.status).toBe(400);
      expect(logistics.send).not.toHaveBeenCalled();
    });
  });
});
