import 'reflect-metadata';
import {
  Controller,
  Get,
  INestApplication,
  Req,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Observable, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter } from '@app/common';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierTokenService } from './auth/carrier-token.service';
import { GlobalThrottlerGuard } from './auth/global-throttler.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtStrategy } from './auth/jwt.strategy';
import { PasswordChangeGuard } from './auth/password-change.guard';
import { TelegramScanScopeGuard } from './auth/telegram-scan-scope.guard';
import { CarrierAuthGatewayController } from './carrier-auth-gateway.controller';
import { CarrierGatewayController } from './carrier-gateway.controller';
import { CarrierOlchaRootGatewayController } from './carrier-olcha-root-gateway.controller';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * OLCHA USLUBI — HAQIQIY Nest routeri, body parser (JSON va form), guard va
 * xato filtri orqali: `POST /carrier/auth/token` → Bearer →
 * `POST /carrier/qrorder/find`. Kutilgan shakllar —
 * https://api.olchamarket.uz/swagger.json (2026-11-27) va jonli Olcha
 * javoblari (401 `{name, message, code: 0, status}`).
 *
 * Ikki manzil (ega 2026-11-27): `/carrier/...` va Olcha'dagi kabi
 * prefikssiz `/auth/token`, `/qrorder/find` — bir xil testlar ikkalasida.
 * `api-gateway.module.ts` dagi global guardlar (IP limiti, xodim JWT,
 * parol, Telegram scope) va `main.ts` URI versiyalash ham shu yerda.
 */
const BASES = ['/carrier', ''] as const;

/** Xodimlar API'si o'rnida: global `JwtAuthGuard` ostidagi oddiy `/auth/*` yo'l. */
@Controller('auth')
class StaffAuthProbeController {
  @Get('validate')
  validate(@Req() req: { user?: { sub?: unknown } }) {
    return { sub: req.user?.sub ?? null };
  }
}

const ACCESS_TOKEN_KEY =
  'f1e2d3c4b5a6978869504132a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const GOOD_KEY = 'elc_good';
const FP_V1 = 'a'.repeat(32);

type Handler = (payload: any) => unknown;
const makeClient = (handlers: Record<string, Handler>) => ({
  send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
    const handler = handlers[pattern.cmd];
    if (!handler)
      return throwError(() => new Error(`unexpected ${pattern.cmd}`));
    try {
      const result = handler(payload);
      return result instanceof Observable ? result : of(result);
    } catch (error) {
      return throwError(() => error);
    }
  }),
});

const validation = (over: Record<string, unknown> = {}) => ({
  id: '3',
  name: 'BTS',
  is_active: true,
  ip_allowlist: null,
  courier_user_id: '55',
  courier_active: true,
  rollback_enabled: false,
  token_fp: FP_V1,
  ...over,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  id: '900',
  qr_code_token: 'qr-900',
  status: 'on the road',
  courier_id: '55',
  total_price: 250000,
  paid_online_amount: 0,
  address: 'Chilonzor 10-kvartal, 5-uy',
  comment: null,
  region_id: '1',
  district_id: '7',
  customer_id: '70',
  customer: { name: 'Ali', phone_number: '+998901112233', extra_number: null },
  region: { id: '1', sato_code: '1726' },
  district: { id: '7', sato_code: '1726294' },
  market_id: '20',
  market: { id: '20', name: 'Shop' },
  items: [{ id: '1', product_id: '1', product_name: 'Kurtka', quantity: 2 }],
  createdAt: '2026-11-27T05:00:00.000Z',
  ...overrides,
});

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe('Carrier API — Olcha uslubi (HTTP)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let currentFp = FP_V1;
  let account = validation();
  let orders: Record<string, Record<string, unknown>> = {};

  const integration = makeClient({
    'integration.carrier.validate_key': ({ api_key }: { api_key: string }) =>
      api_key === GOOD_KEY ? { ...account, token_fp: currentFp } : null,
    'integration.carrier.validate_token': ({
      id,
      token_fp,
    }: {
      id: string;
      token_fp: string;
    }) =>
      id === account.id && token_fp === currentFp
        ? { ...account, token_fp: currentFp }
        : null,
  });
  const orderClient = makeClient({
    'order.find_by_qr_enriched': ({ token }: { token: string }) => {
      const row = orders[token];
      if (!row) {
        return throwError(() => ({
          statusCode: 404,
          message: 'Order not found',
        }));
      }
      return { statusCode: 200, data: row };
    },
  });
  const logistics = makeClient({
    'logistics.post.receive_order': ({ id }: { id: string }) => {
      for (const row of Object.values(orders)) {
        if (row.id === id) row.status = 'waiting';
      }
      return { statusCode: 200 };
    },
  });

  const savedAuthLimit = process.env.CARRIER_AUTH_THROTTLE_LIMIT;
  const savedCarrierLimit = process.env.CARRIER_THROTTLE_LIMIT;

  beforeAll(async () => {
    // Token IP limiti (20/min) testlar soniga yetmasin — limit testi o'zi pasaytiradi.
    process.env.CARRIER_AUTH_THROTTLE_LIMIT = '1000';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => ({ ACCESS_TOKEN_KEY })],
        }),
        JwtModule.register({
          secret: ACCESS_TOKEN_KEY,
          signOptions: { expiresIn: '1h' },
        }),
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 1000 },
        ]),
      ],
      controllers: [
        StaffAuthProbeController,
        CarrierGatewayController,
        CarrierAuthGatewayController,
        CarrierOlchaRootGatewayController,
      ],
      providers: [
        JwtStrategy,
        // api-gateway.module.ts dagi tartib bilan.
        { provide: APP_GUARD, useClass: GlobalThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PasswordChangeGuard },
        { provide: APP_GUARD, useClass: TelegramScanScopeGuard },
        CarrierApiKeyGuard,
        CarrierThrottlerGuard,
        CarrierTokenService,
        { provide: 'INTEGRATION', useValue: integration },
        { provide: 'ORDER', useValue: orderClient },
        { provide: 'LOGISTICS', useValue: logistics },
        { provide: 'FINANCE', useValue: makeClient({}) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // main.ts bilan bir xil: `/x` va `/v1/x`.
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    // main.ts dagi global pipe — Olcha tanasi undan o'tmasligi (xato shakli bizniki) tekshiriladi.
    app.useGlobalPipes(
      new UzValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (app) await app.close();
    restoreEnv('CARRIER_AUTH_THROTTLE_LIMIT', savedAuthLimit);
    restoreEnv('CARRIER_THROTTLE_LIMIT', savedCarrierLimit);
  });

  beforeEach(() => {
    currentFp = FP_V1;
    account = validation();
    orders = {
      'qr-900': order(),
      'qr-sold': order({ id: '901', qr_code_token: 'qr-sold', status: 'sold' }),
      'qr-other': order({
        id: '902',
        qr_code_token: 'qr-other',
        courier_id: '77',
      }),
    };
    logistics.send.mockClear();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const getToken = async (base: string = '/carrier'): Promise<string> => {
    const res = await request(http())
      .post(`${base}/auth/token`)
      .send({ username: '3', password: GOOD_KEY })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  };

  describe.each(BASES)('POST %s/auth/token', (base) => {
    it('⭐ JSON → Olcha AuthTokenResponse: access_token, token_type Bearer, expires_in 3600', async () => {
      const res = await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3', password: GOOD_KEY })
        .expect(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'access_token',
        'expires_in',
        'token_type',
      ]);
      expect(res.body).toMatchObject({
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });

    it('ortiqcha maydon (masalan grant_type) — global pipe 400 bermaydi', async () => {
      await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3', password: GOOD_KEY, grant_type: 'password' })
        .expect(200);
    });

    it('⭐ application/x-www-form-urlencoded ham qabul qilinadi (Olcha kabi)', async () => {
      await request(http())
        .post(`${base}/auth/token`)
        .type('form')
        .send(`username=3&password=${GOOD_KEY}`)
        .expect(200);
    });

    it('⭐ noto‘g‘ri parol YOKI boshqa akkaunt ID — 401, Olcha matni va shakli', async () => {
      for (const body of [
        { username: '3', password: 'elc_wrong' },
        { username: '4', password: GOOD_KEY },
      ]) {
        const res = await request(http())
          .post(`${base}/auth/token`)
          .send(body)
          .expect(401);
        expect(res.body).toMatchObject({
          name: 'Unauthorized',
          message: 'Invalid username or password.',
          code: 0,
          status: 401,
        });
      }
    });

    it('username/password yo‘q — 400, Yii2 shakli', async () => {
      const res = await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3' })
        .expect(400);
      expect(res.body).toMatchObject({
        name: 'Bad Request',
        code: 0,
        status: 400,
      });
      // Xodimlar `/auth/*` shakli (`statusCode`) EMAS.
      expect(res.body).not.toHaveProperty('statusCode');
    });

    it('faol emas akkaunt / kurier — token berilmaydi (403)', async () => {
      account = validation({ is_active: false });
      await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3', password: GOOD_KEY })
        .expect(403);
      account = validation({ courier_active: false });
      const res = await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3', password: GOOD_KEY })
        .expect(403);
      expect(res.body).toMatchObject({
        name: 'Forbidden',
        status: 403,
        error_code: 'CARRIER_COURIER_INACTIVE',
      });
    });

    it('eski integration-service (token_fp yo‘q) — token BERILMAYDI, 503', async () => {
      account = validation({ token_fp: undefined });
      currentFp = undefined as unknown as string;
      await request(http())
        .post(`${base}/auth/token`)
        .send({ username: '3', password: GOOD_KEY })
        .expect(503);
    });
  });

  describe.each(BASES)('POST %s/qrorder/find', (base) => {
    it('⭐ Bearer bilan: Olcha QrOrderResponse, posilka qabul qilinadi (waiting)', async () => {
      const token = await getToken(base);
      const res = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-900' })
        .expect(200);
      expect(res.body).toMatchObject({
        success: true,
        msg: 'Buyurtma topildi va sizga qabul qilindi',
        data: {
          id: 900,
          full_name: 'Ali',
          phone: '998901112233',
          additional_phone: '',
          region: 1726,
          district: 1726294,
          delivery_price: 0,
          total_price: 250000,
          total_count: 2,
          created_at: '2026-11-27 10:00:00',
          items: "Kurtka x 2 = 250 000 so'm",
          status: 'waiting',
        },
      });
      expect(logistics.send).toHaveBeenCalledTimes(1);

      // Takroriy chaqiruv xavfsiz: qayta qabul qilinmaydi.
      const again = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-900' })
        .expect(200);
      expect(again.body).toMatchObject({
        success: true,
        msg: 'Buyurtma topildi',
      });
      expect(logistics.send).toHaveBeenCalledTimes(1);
    });

    it('X-Api-Key bilan ham ishlaydi', async () => {
      await request(http())
        .post(`${base}/qrorder/find`)
        .set('X-Api-Key', GOOD_KEY)
        .send({ qr_code: 'qr-900' })
        .expect(200);
    });

    it('⭐ topilmadi / boshqa kurierniki — HTTP 200, `{success:false, msg, status:404}`', async () => {
      const token = await getToken(base);
      for (const qr of ['qr-missing', 'qr-other']) {
        const res = await request(http())
          .post(`${base}/qrorder/find`)
          .set('Authorization', `Bearer ${token}`)
          .send({ qr_code: qr })
          .expect(200);
        expect(res.body).toMatchObject({
          success: false,
          msg: 'Buyurtma topilmadi yoki sizga biriktirilmagan',
          status: 404,
        });
      }
    });

    it('⭐ yetkazilmoqda holatida emas (sold) — `{success:false, status:400}`', async () => {
      const token = await getToken(base);
      const res = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-sold' })
        .expect(200);
      expect(res.body).toMatchObject({ success: false, status: 400 });
      expect(logistics.send).not.toHaveBeenCalled();
    });

    it('qr_code yo‘q — `{success:false, msg, status:400}`', async () => {
      const token = await getToken(base);
      const res = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({
        success: false,
        msg: 'qr_code majburiy',
        status: 400,
      });
    });

    it('⭐ token yo‘q / soxta — 401 Yii2 shakli (Olcha kabi)', async () => {
      const none = await request(http())
        .post(`${base}/qrorder/find`)
        .send({ qr_code: 'qr-900' })
        .expect(401);
      expect(none.body).toMatchObject({
        name: 'Unauthorized',
        code: 0,
        status: 401,
      });
      await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', 'Bearer x.y.z')
        .send({ qr_code: 'qr-900' })
        .expect(401);
    });

    it('⭐ xodim (kurier) JWT — carrier yo‘liga KIRMAYDI (401, Olcha shakli)', async () => {
      const staff = jwt.sign({ sub: '55', roles: ['courier'] });
      const res = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${staff}`)
        .send({ qr_code: 'qr-900' })
        .expect(401);
      expect(res.body).toMatchObject({
        name: 'Unauthorized',
        code: 0,
        status: 401,
      });
      expect(logistics.send).not.toHaveBeenCalled();
    });

    it('⭐ kalit almashtirilsa (rotate) — eski token darhol 401', async () => {
      const token = await getToken(base);
      currentFp = 'b'.repeat(32);
      const res = await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-900' })
        .expect(401);
      expect(res.body).toMatchObject({ name: 'Unauthorized', status: 401 });
    });

    it('akkaunt to‘xtatilsa — token bilan ham 403', async () => {
      const token = await getToken(base);
      account = validation({ is_active: false });
      await request(http())
        .post(`${base}/qrorder/find`)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-900' })
        .expect(403);
    });
  });

  describe('Olcha manzili (prefikssiz) — faqat domen almashadi', () => {
    const post = (path: string, token: string) =>
      request(http())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send({ qr_code: 'qr-900' });

    it('⭐ token bir manzildan, so‘rov boshqasidan — ikkalasi bir xil ishlaydi', async () => {
      const rootToken = await getToken('');
      await post('/carrier/qrorder/find', rootToken).expect(200);
      await request(http())
        .get('/carrier/ping')
        .set('Authorization', `Bearer ${rootToken}`)
        .expect(200);

      const carrierToken = await getToken('/carrier');
      const res = await post('/qrorder/find', carrierToken).expect(200);
      expect(res.body).toMatchObject({
        success: true,
        msg: 'Buyurtma topildi',
        data: { id: 900, status: 'waiting' },
      });
    });

    it('⭐ ikki manzil javobi AYNAN bir xil', async () => {
      const token = await getToken('');
      await post('/qrorder/find', token).expect(200); // qabul (waiting)
      const viaCarrier = await post('/carrier/qrorder/find', token).expect(200);
      const viaRoot = await post('/qrorder/find', token).expect(200);
      expect(viaRoot.body).toEqual(viaCarrier.body);

      const bad = { username: '3', password: 'elc_wrong' };
      const authCarrier = await request(http())
        .post('/carrier/auth/token')
        .send(bad)
        .expect(401);
      const authRoot = await request(http())
        .post('/auth/token')
        .send(bad)
        .expect(401);
      expect(authRoot.body).toEqual(authCarrier.body);
    });

    it('/v1/auth/token va /v1/qrorder/find ham ochiq (main.ts URI versiyalash)', async () => {
      const res = await request(http())
        .post('/v1/auth/token')
        .send({ username: '3', password: GOOD_KEY })
        .expect(200);
      const token = (res.body as { access_token: string }).access_token;
      await post('/v1/qrorder/find', token).expect(200);
    });

    it('⭐ carrier tokeni xodimlar API’siga KIRMAYDI (401); xodim tokeni o‘z yo‘lida ishlaydi', async () => {
      const carrierToken = await getToken('');
      await request(http())
        .get('/auth/validate')
        .set('Authorization', `Bearer ${carrierToken}`)
        .expect(401);

      const staff = jwt.sign({ sub: '55', roles: ['courier'] });
      const ok = await request(http())
        .get('/auth/validate')
        .set('Authorization', `Bearer ${staff}`)
        .expect(200);
      expect(ok.body).toEqual({ sub: '55' });
    });

    it('⭐ /auth/token limiti — carrier limiti (IP bo‘yicha), 429 Olcha (Yii2) shaklida', async () => {
      process.env.CARRIER_AUTH_THROTTLE_LIMIT = '2';
      try {
        const send = () =>
          request(http())
            .post('/auth/token')
            .set('CF-Connecting-IP', '203.0.113.77')
            .send({ username: '3', password: GOOD_KEY });
        await send().expect(200);
        await send().expect(200);
        const res = await send().expect(429);
        expect(res.body).toMatchObject({
          name: 'Too Many Requests',
          code: 0,
          status: 429,
        });
        expect(res.body).not.toHaveProperty('statusCode');
      } finally {
        process.env.CARRIER_AUTH_THROTTLE_LIMIT = '1000';
      }
    });

    it('⭐ qrorder/find: ikki manzil BITTA akkaunt limitida (ikki baravar emas)', async () => {
      account = validation({ id: '8' }); // yangi akkaunt — toza hisob
      process.env.CARRIER_THROTTLE_LIMIT = '2';
      try {
        // Har so'rov boshqa IP'dan: global IP limiti emas, akkaunt limiti sanaladi.
        const send = (path: string, ip: string) =>
          request(http())
            .post(path)
            .set('X-Api-Key', GOOD_KEY)
            .set('CF-Connecting-IP', ip)
            .send({ qr_code: 'qr-900' });
        await send('/carrier/qrorder/find', '198.51.100.1').expect(200);
        await send('/qrorder/find', '198.51.100.2').expect(200);
        const res = await send('/qrorder/find', '198.51.100.3').expect(429);
        expect(res.body).toMatchObject({
          name: 'Too Many Requests',
          code: 0,
          status: 429,
        });
      } finally {
        restoreEnv('CARRIER_THROTTLE_LIMIT', savedCarrierLimit);
      }
    });

    it('boshqa /carrier/* endpointlar prefikssiz OCHILMAYDI', async () => {
      await request(http()).get('/ping').set('X-Api-Key', GOOD_KEY).expect(404);
      await request(http())
        .post('/scan')
        .set('X-Api-Key', GOOD_KEY)
        .send({ qr_token: 'qr-900' })
        .expect(404);
      await request(http())
        .get('/orders')
        .set('X-Api-Key', GOOD_KEY)
        .expect(404);
    });
  });

  describe('eski /carrier/* — o‘zgarmagan, Bearer’ni ham qabul qiladi', () => {
    it('GET /carrier/ping — X-Api-Key va Bearer, eski javob shakli', async () => {
      const byKey = await request(http())
        .get('/carrier/ping')
        .set('X-Api-Key', GOOD_KEY)
        .expect(200);
      const token = await getToken();
      const byToken = await request(http())
        .get('/carrier/ping')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(byToken.body).toEqual(byKey.body);
      expect(byKey.body).toMatchObject({
        data: { authenticated: true, carrier: { id: '3', name: 'BTS' } },
      });
    });

    it('POST /carrier/scan — xato shakli eskicha (`statusCode`), Olcha shakli EMAS', async () => {
      const res = await request(http())
        .post('/carrier/scan')
        .set('X-Api-Key', GOOD_KEY)
        .send({ qr_token: 'qr-missing' })
        .expect(404);
      expect(res.body).toMatchObject({ statusCode: 404 });
      expect(res.body).not.toHaveProperty('success');
    });
  });
});
