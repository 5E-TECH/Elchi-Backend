import {
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierGatewayController } from './carrier-gateway.controller';
import {
  CARRIER_API_KEY_SCHEME,
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

async function buildApp(
  env: NodeJS.ProcessEnv,
): Promise<{ app: INestApplication; result: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
      }),
    ],
    controllers: [CarrierGatewayController, InternalProbeController],
    providers: [
      CarrierThrottlerGuard,
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

    it('faqat /carrier/* marshrutlari — ichki marshrut yo‘q', () => {
      expect(Object.keys(doc.paths).sort()).toEqual([
        '/carrier/cashbox',
        '/carrier/orders',
        '/carrier/orders/{id}/status',
        '/carrier/ping',
        '/carrier/returns',
        '/carrier/scan',
      ]);
      expect(JSON.stringify(doc)).not.toContain('/orders/secret');
    });

    it('X-Api-Key sxemasi — Authorize tugmasi; boshqa sxemalar yo‘q', () => {
      expect(doc.components?.securitySchemes).toEqual({
        [CARRIER_API_KEY_SCHEME]: {
          type: 'apiKey',
          name: 'X-Api-Key',
          in: 'header',
        },
      });
      expect(doc.security).toEqual([{ [CARRIER_API_KEY_SCHEME]: [] }]);
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
        serverUrl: 'https://api.elchipochta.uz',
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

    it('statik spec’da server manzili bor; quantity — integer', () => {
      expect(doc.servers).toEqual([
        expect.objectContaining({ url: 'https://api.elchipochta.uz' }),
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
