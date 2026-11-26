import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { ROLES_KEY } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { IntegrationGatewayController } from './integration-gateway.controller';
import {
  isExternalSiteRow,
  safeSiteUrl,
  toSiteListResponse,
} from './integration-site-view';

/**
 * 9rzmWFVm — «Qabul va yaratish» → «Tashqi saytlar» registratorda ham.
 *
 * Avval `GET /integrations` va `GET /integrations/:id` — faqat SUPERADMIN,
 * ADMIN (registrator 403, tab chizilmasdi). Endi REGISTRATOR ham kiradi, lekin
 * javobi OQ RO'YXAT: faqat sayt ulanishlar, sozlamasiz (auth, dispatch,
 * webhook, to'lov, `username`, `credentials` yo'q). Admin javobi o'zgarmagan.
 */
const SECRET_KEYS = [
  'credentials',
  'username',
  'auth_type',
  'auth_url',
  'dispatch_config',
  'inbound_order_config',
  'payment_config',
  'webhook_enabled',
  'webhook_signature_header',
  'has_webhook_secret',
  'status_mapping',
];

const site = {
  id: '2',
  name: 'Alion',
  slug: 'alion',
  type: 'custom',
  role: 'source',
  category: 'marketplace',
  status: 'active',
  is_active: true,
  market_id: '510',
  base_url: 'https://user:pass@alion.uz/api/qrorder/find?token=abc#x',
  api_url: 'https://alion.uz/api',
  auth_type: 'login',
  auth_url: 'https://alion.uz/auth',
  username: 'elchi-bot',
  credentials: { password: '********' },
  field_mapping: { customer_name: 'client.name' },
  status_mapping: { 1: 'new' },
  status_sync_config: {
    external_search: {
      endpoint: '/qrorder/find?key=secret',
      headers: { k: 'v' },
    },
    poll: true,
  },
  dispatch_config: { url: 'https://x' },
  inbound_order_config: { a: 1 },
  payment_config: { b: 2 },
  webhook_enabled: true,
  webhook_signature_header: 'x-sig',
  has_webhook_secret: true,
  imported_orders: { total: 3, today: 1, last_at: '2026-11-25T10:00:00Z' },
};
const carrier = {
  ...site,
  id: '1',
  name: 'Kargo',
  role: 'carrier',
  market_id: null,
};
const payment = { ...site, id: '3', name: 'Payme', role: 'payment' };
const inactive = { ...site, id: '4', name: 'Eski', is_active: false };

describe('9rzmWFVm — integration-site-view (sof funksiyalar)', () => {
  it('sayt — faol, marketi bor, to‘lov emas', () => {
    expect(isExternalSiteRow(site)).toBe(true);
    expect(isExternalSiteRow(carrier)).toBe(false);
    expect(isExternalSiteRow(payment)).toBe(false);
    expect(isExternalSiteRow(inactive)).toBe(false);
    expect(isExternalSiteRow(null)).toBe(false);
  });

  it('manzildan login/parol, query va # olib tashlanadi', () => {
    expect(safeSiteUrl(site.base_url)).toBe(
      'https://alion.uz/api/qrorder/find',
    );
    expect(safeSiteUrl('/qrorder/find?key=secret')).toBe('/qrorder/find');
    expect(safeSiteUrl('')).toBeNull();
    expect(safeSiteUrl({})).toBeNull();
  });

  it('ro‘yxat: faqat saytlar, sozlamasiz; markets — faqat saytlarniki, {id,name}', () => {
    const res = toSiteListResponse({
      statusCode: 200,
      message: 'success',
      data: {
        items: [site, carrier, payment, inactive],
        market: null,
        markets: [
          {
            id: '510',
            name: 'Alion market',
            password: 'h',
            market_tg_token: 't',
          },
          { id: '999', name: 'Begona' },
        ],
        meta: { page: 1, limit: 200, total: 4, totalPages: 1 },
      },
    }) as {
      statusCode: number;
      data: {
        items: Array<Record<string, unknown>>;
        markets: unknown[];
        meta: Record<string, number>;
      };
    };
    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((item) => item.id)).toEqual(['2']);
    const [item] = res.data.items;
    for (const key of SECRET_KEYS) expect(item).not.toHaveProperty(key);
    expect(item).toEqual(
      expect.objectContaining({
        id: '2',
        name: 'Alion',
        slug: 'alion',
        market_id: '510',
        base_url: 'https://alion.uz/api/qrorder/find',
        field_mapping: { customer_name: 'client.name' },
        status_sync_config: { external_search: { endpoint: '/qrorder/find' } },
        imported_orders: {
          total: 3,
          today: 1,
          last_at: '2026-11-25T10:00:00Z',
        },
      }),
    );
    expect(res.data.markets).toEqual([{ id: '510', name: 'Alion market' }]);
    expect(res.data.meta).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    });
  });
});

describe('9rzmWFVm — GET /integrations, /integrations/:id (HTTP)', () => {
  let app: INestApplication;
  const send = jest.fn();
  let roles: string[] = ['registrator'];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationGatewayController],
      providers: [{ provide: 'INTEGRATION', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user: unknown }>().user = {
            sub: '9',
            roles,
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;

  beforeEach(() => {
    send.mockReset();
    roles = ['registrator'];
  });

  it('@Roles: registrator qo‘shilgan (faqat o‘qish yo‘llari)', () => {
    const proto = IntegrationGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    const rolesOf = (method: string) =>
      Reflect.getMetadata(ROLES_KEY, proto[method]) as string[] | undefined;
    expect(rolesOf('findAll')).toEqual(['superadmin', 'admin', 'registrator']);
    expect(rolesOf('findById')).toEqual(['superadmin', 'admin', 'registrator']);
    // ⛔ yozish yo'llari o'zgarmagan.
    for (const method of ['create', 'update', 'remove']) {
      const value = rolesOf(method);
      if (value) expect(value).not.toContain('registrator');
    }
  });

  it('registrator ro‘yxati — filtrlar e’tiborga olinmaydi, faqat faol saytlar, sozlamasiz', async () => {
    send.mockReturnValue(
      of({
        statusCode: 200,
        data: { items: [site, carrier], markets: [{ id: '510', name: 'M' }] },
      }),
    );
    const res = await request(http()).get(
      '/integrations?role=carrier&is_active=false&page=3&limit=5',
    );
    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'integration.find_all' },
      { query: { is_active: true, page: 1, limit: 200 } },
    ]);
    const body = res.body as {
      data: { items: Array<Record<string, unknown>> };
    };
    expect(body.data.items.map((item) => item.id)).toEqual(['2']);
    for (const key of SECRET_KEYS)
      expect(body.data.items[0]).not.toHaveProperty(key);
  });

  it('admin ro‘yxati — o‘zgarmagan (filtrlar o‘tadi, to‘liq javob)', async () => {
    roles = ['admin'];
    send.mockReturnValue(
      of({ statusCode: 200, data: { items: [site, carrier] } }),
    );
    const res = await request(http()).get(
      '/integrations?role=carrier&page=2&limit=5',
    );
    expect(res.status).toBe(200);
    expect(lastCall()?.[1]).toEqual({
      query: expect.objectContaining({
        role: 'carrier',
        page: 2,
        limit: 5,
      }) as unknown,
    });
    const body = res.body as {
      data: { items: Array<Record<string, unknown>> };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toHaveProperty('username', 'elchi-bot');
  });

  it('registrator :id — sayt bo‘lsa sozlamasiz ko‘rinish', async () => {
    send.mockReturnValue(
      of({
        statusCode: 200,
        message: 'success',
        data: { ...site, market: { id: '510', name: 'M', password: 'h' } },
      }),
    );
    const res = await request(http()).get('/integrations/2');
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    for (const key of SECRET_KEYS) expect(body.data).not.toHaveProperty(key);
    expect(body.data.market).toEqual({ id: '510', name: 'M' });
  });

  it('⛔ registrator :id — sayt bo‘lmagan ulanish 404', async () => {
    for (const row of [carrier, payment, inactive]) {
      send.mockReturnValue(of({ statusCode: 200, data: row }));
      const res = await request(http()).get(`/integrations/${row.id}`);
      expect(res.status).toBe(404);
    }
  });

  it('admin :id — o‘zgarmagan (to‘liq javob, kargo ham)', async () => {
    roles = ['superadmin'];
    send.mockReturnValue(of({ statusCode: 200, data: carrier }));
    const res = await request(http()).get('/integrations/1');
    expect(res.status).toBe(200);
    expect((res.body as { data: Record<string, unknown> }).data).toHaveProperty(
      'dispatch_config',
    );
  });
});
