import {
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierTokenService } from './auth/carrier-token.service';
import { CarrierAuthGatewayController } from './carrier-auth-gateway.controller';
import { CarrierGatewayController } from './carrier-gateway.controller';
import { CarrierOlchaRootGatewayController } from './carrier-olcha-root-gateway.controller';
import {
  CARRIER_API_KEY_SCHEME,
  CARRIER_BEARER_SCHEME,
  CARRIER_API_SERVERS,
  CARRIER_SWAGGER_GUIDE,
  buildCarrierSwaggerDocument,
  filterCarrierDocument,
  parseCarrierSwaggerFlag,
  setupCarrierSwagger,
} from './carrier-swagger';
import { toCarrierOrderView } from './carrier-order-view';
import { toCarrierCashboxView } from './carrier-cashbox-view';

/** Ichki marshrut — carrier hujjatiga TUSHMASLIGI kerak. */
@Controller('orders')
class InternalProbeController {
  @Get('secret')
  secret() {
    return { ok: true };
  }
}

/** Xodimlar `/auth/*` — prefikssiz `/auth/token` bilan yonma-yon, hujjatga TUSHMAYDI. */
@Controller('auth')
class StaffAuthProbeController {
  @Post('login')
  login() {
    return { ok: true };
  }
}

async function buildApp(
  env: NodeJS.ProcessEnv,
): Promise<{ app: INestApplication; result: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
      }),
    ],
    controllers: [
      CarrierGatewayController,
      CarrierAuthGatewayController,
      CarrierOlchaRootGatewayController,
      InternalProbeController,
      StaffAuthProbeController,
    ],
    providers: [
      CarrierThrottlerGuard,
      CarrierApiKeyGuard,
      { provide: CarrierTokenService, useValue: {} },
      { provide: 'ORDER', useValue: { send: jest.fn() } },
      { provide: 'LOGISTICS', useValue: { send: jest.fn() } },
      { provide: 'FINANCE', useValue: { send: jest.fn() } },
      { provide: 'INTEGRATION', useValue: { send: jest.fn() } },
    ],
  })
    .overrideGuard(CarrierApiKeyGuard)
    .useValue({
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<{ carrier?: unknown }>();
        req.carrier = { id: '3', name: 'BTS', courier_user_id: '55' };
        return true;
      },
    })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  const result = setupCarrierSwagger(app, env);
  await app.init();
  return { app, result };
}

type SchemaObject = { properties?: Record<string, unknown> };

const schemaProps = (doc: OpenAPIObject, name: string): string[] =>
  Object.keys(
    (doc.components?.schemas?.[name] as SchemaObject | undefined)?.properties ??
      {},
  ).sort();

describe('Carrier API Swagger (/carrier-docs)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('hujjat mazmuni', () => {
    let doc: OpenAPIObject;

    beforeAll(async () => {
      const built = await buildApp({ NODE_ENV: 'development' });
      doc = buildCarrierSwaggerDocument(built.app);
      await built.app.close();
    });

    it('faqat /carrier/* (+ Olcha manzillari) — ichki marshrut yo‘q', () => {
      expect(Object.keys(doc.paths).sort()).toEqual([
        // Olcha'dagi kabi prefikssiz (ega 2026-11-27: «Ha, qo'sh»).
        '/auth/token',
        // Olcha uslubi (ega 2026-11-27).
        '/carrier/auth/token',
        '/carrier/cashbox',
        '/carrier/orders',
        '/carrier/orders/{id}/status',
        '/carrier/ping',
        '/carrier/qrorder/find',
        '/carrier/returns',
        '/carrier/scan',
        '/qrorder/find',
      ]);
      expect(JSON.stringify(doc)).not.toContain('/orders/secret');
      // Xodimlar `/auth/*` chiqmaydi — faqat `/auth/token`.
      expect(JSON.stringify(doc)).not.toContain('/auth/login');
    });

    it('X-Api-Key va Olcha uslubidagi Bearer — Authorize tugmasi; boshqa sxemalar yo‘q', () => {
      expect(doc.components?.securitySchemes).toEqual({
        [CARRIER_API_KEY_SCHEME]: {
          type: 'apiKey',
          name: 'X-Api-Key',
          in: 'header',
        },
        [CARRIER_BEARER_SCHEME]: expect.objectContaining({
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }) as unknown,
      });
      // Ikkalasidan biri (OR).
      expect(doc.security).toEqual([
        { [CARRIER_API_KEY_SCHEME]: [] },
        { [CARRIER_BEARER_SCHEME]: [] },
      ]);
    });

    it('⭐ token olish yo‘li kirishsiz; qolgan yo‘llar kalit YOKI Bearer', () => {
      const ops = doc.paths as Record<
        string,
        Record<string, { security?: unknown }>
      >;
      expect(ops['/carrier/auth/token'].post.security).toEqual([]);
      expect(ops['/auth/token'].post.security).toEqual([]);
      for (const [path, method] of [
        ['/carrier/qrorder/find', 'post'],
        ['/qrorder/find', 'post'],
        ['/carrier/scan', 'post'],
        ['/carrier/ping', 'get'],
      ]) {
        expect(ops[path][method].security).toEqual(
          expect.arrayContaining([
            { [CARRIER_API_KEY_SCHEME]: [] },
            { [CARRIER_BEARER_SCHEME]: [] },
          ]),
        );
      }
    });

    it('⭐ Olcha manzili (`/auth/token`, `/qrorder/find`) = `/carrier/...` hujjati (faqat nom/izoh farq)', () => {
      type Op = Record<string, unknown>;
      const ops = doc.paths as Record<string, Record<string, Op>>;
      const strip = (op: Op): Op => {
        const rest = { ...op };
        delete rest.operationId;
        delete rest.summary;
        delete rest.description;
        return rest;
      };
      for (const [root, carrier] of [
        ['/auth/token', '/carrier/auth/token'],
        ['/qrorder/find', '/carrier/qrorder/find'],
      ]) {
        expect(Object.keys(ops[root])).toEqual(['post']);
        expect(strip(ops[root].post)).toEqual(strip(ops[carrier].post));
        expect(ops[root].post.operationId).not.toBe(
          ops[carrier].post.operationId,
        );
        expect(ops[root].post.summary).toContain('Olcha manzili');
        expect(ops[root].post.description).toContain('api.elchipochta.uz');
      }
      // qrorder/find xatolari — Olcha shaklida (401/403/429 Yii2, 5xx `{success:false}`).
      const responses = ops['/qrorder/find'].post.responses as Record<
        string,
        { content?: Record<string, { schema?: { $ref?: string } }> }
      >;
      const ref = (code: string) =>
        responses[code]?.content?.['application/json']?.schema?.$ref ?? '';
      for (const code of ['401', '403', '429']) {
        expect(ref(code)).toMatch(/CarrierOlchaErrorDto$/);
      }
      for (const code of ['503', '504']) {
        expect(ref(code)).toMatch(/CarrierQrOrderFailDto$/);
      }
    });

    it('⭐ Olcha sxemalari: AuthToken, QrOrder maydonlari Olcha swagger’idagi bilan bir xil', () => {
      // https://api.olchamarket.uz/swagger.json — AuthTokenRequest/Response, QrOrderRequest/Response.
      expect(schemaProps(doc, 'CarrierAuthTokenRequestDto')).toEqual([
        'password',
        'username',
      ]);
      expect(schemaProps(doc, 'CarrierAuthTokenResponseDto')).toEqual([
        'access_token',
        'expires_in',
        'token_type',
      ]);
      expect(schemaProps(doc, 'CarrierQrOrderRequestDto')).toEqual(['qr_code']);
      expect(schemaProps(doc, 'CarrierQrOrderResponseDto')).toEqual([
        'data',
        'msg',
        'success',
      ]);
      expect(schemaProps(doc, 'CarrierQrOrderDataDto')).toEqual(
        expect.arrayContaining([
          'id',
          'full_name',
          'phone',
          'additional_phone',
          'region',
          'district',
          'address',
          'comment',
          'delivery_price',
          'total_price',
          'total_count',
          'created_at',
          'items',
        ]),
      );
    });

    it('tavsif — qisqa qo‘llanma; teglar faqat Carrier', () => {
      expect(doc.info.title).toBe('Elchi Pochta — Carrier API');
      expect(doc.info.description).toBe(CARRIER_SWAGGER_GUIDE);
      expect((doc.tags ?? []).map((t) => t.name)).toEqual(['Carrier']);
    });

    it('javob sxemasi = haqiqiy javob (toCarrierOrderView / toCarrierCashboxView)', () => {
      expect(schemaProps(doc, 'CarrierOrderDto')).toEqual(
        Object.keys(toCarrierOrderView({ id: '1' })).sort(),
      );
      // Viloyat/tuman — nom emas, SOATO kodi.
      expect(schemaProps(doc, 'CarrierGeoRefDto')).toEqual([
        'id',
        'soato_code',
      ]);
      const geo = toCarrierOrderView({
        id: '1',
        region: { id: '1', name: 'X', sato_code: '1726' },
      }).region;
      expect(Object.keys(geo ?? {}).sort()).toEqual(['id', 'soato_code']);
      // Kassa: view kalitlari + tarix oynasi (from/to).
      expect(schemaProps(doc, 'CarrierCashboxDataDto')).toEqual(
        [...Object.keys(toCarrierCashboxView({})), 'from', 'to'].sort(),
      );
      expect(schemaProps(doc, 'CarrierScanDataDto')).toEqual([
        'order',
        'received',
        'refreshed',
      ]);
      expect(schemaProps(doc, 'CarrierErrorResponseDto')).toContain('code');
      expect(schemaProps(doc, 'CarrierReplacementDto')).toEqual([
        'of_order_id',
        'old_item_required',
      ]);
      expect(schemaProps(doc, 'CarrierCashboxEntryDto')).toEqual(
        Object.keys(
          toCarrierCashboxView({ data: { cashboxHistory: [{ id: 1 }] } })
            .history[0],
        ).sort(),
      );
    });

    it('har bir $ref hujjat ichida mavjud (sinmagan havola yo‘q)', () => {
      const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map(
        (m) => m[1].split('/').pop() as string,
      );
      expect(refs.length).toBeGreaterThan(5);
      for (const name of refs) {
        expect(doc.components?.schemas).toHaveProperty(name);
      }
    });
  });

  describe('so‘rov tanasi va statik spec', () => {
    let doc: OpenAPIObject;
    beforeAll(async () => {
      const built = await buildApp({ NODE_ENV: 'development' });
      doc = buildCarrierSwaggerDocument(built.app, {
        servers: CARRIER_API_SERVERS,
      });
      await built.app.close();
    });

    it('⭐ JSON tanasida `proof` (binary) YO‘Q, multipart’da bor', () => {
      const content = (
        doc.paths['/carrier/orders/{id}/status'].post as {
          requestBody: {
            content: Record<string, { schema: Record<string, unknown> }>;
          };
        }
      ).requestBody.content;
      expect(content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/CarrierOrderStatusRequestDto',
      });
      expect(JSON.stringify(content['multipart/form-data'].schema)).toContain(
        '"format":"binary"',
      );
    });

    it('statik spec’da production va test serverlari bor; quantity — integer', () => {
      expect(doc.servers).toEqual([
        {
          url: 'https://api.elchipochta.uz',
          description: expect.stringContaining('Production'),
        },
        {
          url: 'https://test-api.elchipochta.uz',
          description: expect.stringContaining('Test'),
        },
      ]);
      const item = doc.components?.schemas?.CarrierPartlySoldItemDto as {
        properties: Record<string, { type?: string }>;
      };
      expect(item.properties.quantity.type).toBe('integer');
    });
  });

  describe('parseCarrierSwaggerFlag', () => {
    it('true/1/yes — on, false/0/no — off, qolgani — sukut', () => {
      for (const v of ['true', 'TRUE', ' 1 ', 'yes']) {
        expect(parseCarrierSwaggerFlag(v)).toBe('on');
      }
      for (const v of ['false', '0', 'No']) {
        expect(parseCarrierSwaggerFlag(v)).toBe('off');
      }
      for (const v of ['', undefined, 'maybe']) {
        expect(parseCarrierSwaggerFlag(v)).toBe('default');
      }
    });
  });

  describe('filterCarrierDocument', () => {
    it('ishlatilmagan sxema va begona xavfsizlik sxemalari olib tashlanadi', () => {
      const out = filterCarrierDocument({
        openapi: '3.0.0',
        info: { title: 't', version: '1' },
        tags: [{ name: 'Carrier' }, { name: 'Orders' }],
        paths: {
          '/carrier/ping': {
            get: {
              responses: {
                200: {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/A' },
                    },
                  },
                },
              },
            },
          },
          '/orders': { get: { responses: {} } },
        },
        components: {
          schemas: {
            A: { properties: { b: { $ref: '#/components/schemas/B' } } },
            B: { type: 'object' },
            Internal: { type: 'object' },
          },
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer' },
            [CARRIER_API_KEY_SCHEME]: {
              type: 'apiKey',
              name: 'X-Api-Key',
              in: 'header',
            },
          },
        },
      });
      expect(Object.keys(out.paths)).toEqual(['/carrier/ping']);
      expect(Object.keys(out.components?.schemas ?? {}).sort()).toEqual([
        'A',
        'B',
      ]);
      expect(Object.keys(out.components?.securitySchemes ?? {})).toEqual([
        CARRIER_API_KEY_SCHEME,
      ]);
      expect(out.tags).toEqual([{ name: 'Carrier' }]);
    });
  });

  describe('ulanish qoidalari', () => {
    it('dev: sukut bo‘yicha ochiq, JSON faqat carrier yo‘llari', async () => {
      const built = await buildApp({ NODE_ENV: 'development' });
      app = built.app;
      expect(built.result).toBe('mounted');
      const res = await request(app.getHttpServer()).get('/carrier-docs-json');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.paths)).toContain('/carrier/scan');
      expect(Object.keys(res.body.paths)).not.toContain('/orders/secret');
      expect(
        (await request(app.getHttpServer()).get('/carrier-docs')).status,
      ).toBeLessThan(400);
    });

    it('dev: CARRIER_SWAGGER_ENABLED=false — ulanmaydi', async () => {
      const built = await buildApp({
        NODE_ENV: 'development',
        CARRIER_SWAGGER_ENABLED: 'false',
      });
      app = built.app;
      expect(built.result).toBe('disabled');
      expect(
        (await request(app.getHttpServer()).get('/carrier-docs-json')).status,
      ).toBe(404);
    });

    it('⭐ production: flag yo‘q — ulanmaydi', async () => {
      const built = await buildApp({
        NODE_ENV: 'production',
        CARRIER_SWAGGER_PASSWORD: 'secret-pass',
      });
      app = built.app;
      expect(built.result).toBe('disabled');
      expect(
        (await request(app.getHttpServer()).get('/carrier-docs-json')).status,
      ).toBe(404);
    });

    it('⭐ production: yoqilgan, lekin parolsiz — ulanmaydi (yopiq)', async () => {
      const built = await buildApp({
        NODE_ENV: 'production',
        CARRIER_SWAGGER_ENABLED: 'true',
      });
      app = built.app;
      expect(built.result).toBe('disabled_no_password');
      expect(
        (await request(app.getHttpServer()).get('/carrier-docs-json')).status,
      ).toBe(404);
    });

    it('⭐ production: yoqilgan + parol — Basic Auth bilan ochiladi', async () => {
      const built = await buildApp({
        NODE_ENV: 'production',
        CARRIER_SWAGGER_ENABLED: 'true',
        CARRIER_SWAGGER_USER: 'bts',
        CARRIER_SWAGGER_PASSWORD: 'secret-pass',
      });
      app = built.app;
      expect(built.result).toBe('mounted');
      const server = app.getHttpServer();
      expect((await request(server).get('/carrier-docs-json')).status).toBe(
        401,
      );
      expect((await request(server).get('/carrier-docs')).status).toBe(401);
      // ⭐ YAML umuman berilmaydi — Basic Auth'ni chetlab o'tib bo'lmaydi.
      expect([401, 404]).toContain(
        (await request(server).get('/carrier-docs-yaml')).status,
      );
      const yaml = await request(server).get('/carrier-docs-yaml');
      expect(yaml.text).not.toContain('/carrier/ping');
      const ok = await request(server)
        .get('/carrier-docs-json')
        .auth('bts', 'secret-pass');
      expect(ok.status).toBe(200);
      expect(ok.body.info.title).toBe('Elchi Pochta — Carrier API');
      // Basic Auth faqat hujjatga — API'ning o'zi X-Api-Key bilan.
      expect((await request(server).get('/carrier/ping')).status).toBe(200);
    });
  });

  it('qo‘llanmadagi «Muhitlar» = statik spec serverlari; misollarda qattiq host yo‘q', () => {
    for (const server of CARRIER_API_SERVERS) {
      expect(CARRIER_SWAGGER_GUIDE).toContain(`| \`${server.url}\` |`);
      expect(CARRIER_SWAGGER_GUIDE).toContain(`\`${server.url}/carrier-docs\``);
    }
    // curl misollari faqat BASE_URL orqali — test'chi production'ga yuborilmaydi.
    const curlLines = CARRIER_SWAGGER_GUIDE.split('\n').filter((line) =>
      line.startsWith('curl'),
    );
    expect(curlLines.length).toBeGreaterThanOrEqual(3);
    for (const line of curlLines) {
      expect(line).toContain('"$BASE_URL/carrier/');
    }
  });

  it('docs/public/CARRIER_API_QUICKSTART.md = Swagger’dagi qo‘llanma', () => {
    const file = readFileSync(
      join(__dirname, '../../../docs/public/CARRIER_API_QUICKSTART.md'),
      'utf8',
    );
    expect(file).toBe(
      `# Elchi Pochta — Carrier API: tezkor qo'llanma\n\n${CARRIER_SWAGGER_GUIDE}\n`,
    );
  });

  it('main.ts carrier Swagger’ni ulaydi', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toContain('setupCarrierSwagger(app)');
  });
});
