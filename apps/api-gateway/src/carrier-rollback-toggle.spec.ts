import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { join } from 'path';
import { of, throwError } from 'rxjs';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierGatewayController } from './carrier-gateway.controller';
import {
  CARRIER_STATUS_PIPE_OPTIONS,
  carrierStatusRejected,
} from './carrier-status-body';
import { requestContextMiddleware } from './context/request-context.middleware';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * YASHIRIN ROLLBACK TOGGLE'I — HTTP darajasida, `main.ts` dagi AYNI zanjir:
 * haqiqiy `CarrierApiKeyGuard` (integration javobi soxta), global
 * `UzValidationPipe` + `AllExceptionsFilter`, `FileInterceptor`, kontroller.
 *
 * Egasi (2026-11-14): kompaniya bilan endi ishlay boshladik — rollback sukut
 * bo'yicha O'CHIQ, admin akkaunt bo'yicha yoqadi; kompaniya rollback borligini
 * BILMASLIGI kerak. Shu bois o'chiq akkauntning `status: rollback` i istalgan
 * noma'lum qiymat (`sould`) bilan BAYTMA-BAYT bir xil javob oladi (trace_id
 * dan tashqari) va hech qanday amal bajarilmaydi: buyurtma o'qilmaydi,
 * Idempotency-Key order-service'ga yetmaydi (u yerda saqlanadi), RMQ
 * amali / kassa yozuvi / fayl yuklash yo'q.
 */

const STATUS_PATH = '/carrier/orders/1201/status';
const KEY = 'elc_test_key';
const PUBLIC_ONLY_MESSAGE =
  "status: quyidagilardan biri bo'lishi kerak: sold, partly_sold, cancelled";

const RAW_ORDER = {
  id: '1201',
  status: 'sold',
  courier_id: '55',
  holder_courier_id: '55',
  total_price: 250000,
  items: [{ id: '5501', product_id: '1', product_name: 'Kurtka', quantity: 1 }],
};

/** integration `validate_key` javobi — `rollback_enabled` testda o'zgaradi. */
const account = { rollbackEnabled: false };

const integrationClient = {
  send: jest.fn(() =>
    of({
      id: '3',
      name: 'BTS',
      is_active: true,
      ip_allowlist: null,
      courier_user_id: '55',
      courier_active: true,
      rollback_enabled: account.rollbackEnabled,
    }),
  ),
};

/** ORDER: rollback'dan keyin buyurtma `waiting` ga o'tadi. */
let orderStatus = 'sold';
const orderClient = {
  send: jest.fn((pattern: { cmd: string }) => {
    if (
      pattern.cmd === 'order.find_by_id' ||
      pattern.cmd === 'order.find_by_id_enriched'
    ) {
      return of({
        statusCode: 200,
        data: { ...RAW_ORDER, status: orderStatus },
      });
    }
    if (pattern.cmd === 'order.rollback_waiting') {
      orderStatus = 'waiting';
      return of({ statusCode: 200, data: {} });
    }
    return throwError(() => new Error(`kutilmagan cmd ${pattern.cmd}`));
  }),
};
const logisticsClient = { send: jest.fn() };
const financeClient = { send: jest.fn() };
const fileClient = { send: jest.fn() };

type Res = { status: number; body: Record<string, unknown> };

/** Javob tanasi — `trace_id` har so'rovda yangi, solishtirishdan chiqariladi. */
const comparable = (res: Res) => {
  const body = { ...res.body };
  delete body.trace_id;
  return { status: res.status, body };
};

describe('Carrier rollback toggle (yashirin) — HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
        }),
      ],
      controllers: [CarrierGatewayController],
      providers: [
        CarrierApiKeyGuard,
        CarrierThrottlerGuard,
        { provide: 'INTEGRATION', useValue: integrationClient },
        { provide: 'ORDER', useValue: orderClient },
        { provide: 'LOGISTICS', useValue: logisticsClient },
        { provide: 'FINANCE', useValue: financeClient },
        { provide: 'FILE', useValue: fileClient },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(requestContextMiddleware);
    app.useGlobalPipes(
      new UzValidationPipe({ ...CARRIER_STATUS_PIPE_OPTIONS }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    account.rollbackEnabled = false;
    orderStatus = 'sold';
    for (const client of [
      integrationClient,
      orderClient,
      logisticsClient,
      financeClient,
      fileClient,
    ]) {
      client.send.mockClear();
    }
  });

  const server = () => app.getHttpServer() as Server;

  const postJson = async (
    body: object,
    opts: { idempotencyKey?: string | null; path?: string } = {},
  ): Promise<Res> => {
    let req = request(server())
      .post(opts.path ?? STATUS_PATH)
      .set('X-Api-Key', KEY);
    if (opts.idempotencyKey !== null) {
      req = req.set(
        'Idempotency-Key',
        opts.idempotencyKey ?? '6f1c2a8e-4b7d-4c1e-9a3f-2d5b8e7c1a90',
      );
    }
    const res = await req.send(body);
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  const postMultipart = async (status: string): Promise<Res> => {
    const res = await request(server())
      .post(STATUS_PATH)
      .set('X-Api-Key', KEY)
      .set('Idempotency-Key', '0b6c3a3e-9f0e-4e35-9d0f-8f6f3c1d2a11')
      .field('status', status)
      .attach('proof', Buffer.from('fake-png'), {
        filename: 'proof.png',
        contentType: 'image/png',
      });
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  const expectNoSideEffects = () => {
    expect(orderClient.send).not.toHaveBeenCalled();
    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(financeClient.send).not.toHaveBeenCalled();
    expect(fileClient.send).not.toHaveBeenCalled();
  };

  describe('o‘chiq (sukut) — rollback = noma’lum status', () => {
    it('⭐ 400, xabar faqat sold/partly_sold/cancelled, "rollback" so‘zi yo‘q, hech qanday amal yo‘q', async () => {
      const res = await postJson({ status: 'rollback' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: PUBLIC_ONLY_MESSAGE,
      });
      expect(res.body).not.toHaveProperty('code');
      expect(JSON.stringify(res.body)).not.toMatch(/rollback/i);
      expectNoSideEffects();
      // Kalit har so'rovda tekshirildi (guard keshlamaydi).
      expect(integrationClient.send).toHaveBeenCalledTimes(1);
    });

    it('⭐ javob noma’lum qiymat (`sould`) bilan AYNAN bir xil — boshqa xatolar bilan birga ham', async () => {
      const pairs: Array<
        [object, object, { idempotencyKey?: null; path?: string }?]
      > = [
        [{ status: 'rollback' }, { status: 'sould' }],
        [
          { status: 'rollback', extraCost: 5000 },
          { status: 'sould', extraCost: 5000 },
        ],
        [
          { status: 'rollback', comment: 'x'.repeat(1001) },
          { status: 'sould', comment: 'x'.repeat(1001) },
        ],
        // Idempotency-Key yo'q / buyurtma id xato — baribir status xatosi birinchi.
        [{ status: 'rollback' }, { status: 'sould' }, { idempotencyKey: null }],
        [
          { status: 'rollback' },
          { status: 'sould' },
          { path: '/carrier/orders/abc/status' },
        ],
      ];
      for (const [hidden, unknown, opts] of pairs) {
        const a = comparable(await postJson(hidden, opts));
        const b = comparable(await postJson(unknown, opts));
        expect(a).toEqual(b);
        expect(a.status).toBe(400);
        expect(JSON.stringify(a.body)).not.toMatch(/rollback/i);
      }
      expectNoSideEffects();
    });

    it('⭐ multipart + proof fayli: ayni 400, fayl yuklanmaydi', async () => {
      const a = comparable(await postMultipart('rollback'));
      const b = comparable(await postMultipart('sould'));
      expect(a).toEqual(b);
      expect(a.body).toMatchObject({ message: PUBLIC_ONLY_MESSAGE });
      expectNoSideEffects();
    });

    it('kontroller himoyasi (pipe chetlab o‘tilsa) — ayni konvert', () => {
      expect(carrierStatusRejected().getResponse()).toEqual({
        message: [PUBLIC_ONLY_MESSAGE],
        error: 'Bad Request',
        statusCode: 400,
      });
    });
  });

  describe('yoqiq — avvalgi xulq', () => {
    it('⭐ rollback -> order.rollback_waiting (kurier nomidan, request_id bilan), 200', async () => {
      account.rollbackEnabled = true;
      const res = await postJson({ status: 'rollback' });
      expect(res.status).toBe(200);
      const action = orderClient.send.mock.calls.find(
        ([pattern]) => pattern.cmd === 'order.rollback_waiting',
      ) as unknown as [{ cmd: string }, Record<string, unknown>] | undefined;
      expect(action?.[1]).toMatchObject({
        id: '1201',
        dto: { target_status: 'waiting' },
        requester: { id: '55', roles: ['courier'] },
      });
      expect(String(action?.[1].request_id)).toMatch(/^idem:55:[0-9a-f]{64}$/);
      expect(res.body).toMatchObject({ data: { refreshed: true } });
    });

    it('⭐ xato qiymat xabarida rollback baribir YO‘Q; boshqa maydon xatosi — oddiy', async () => {
      account.rollbackEnabled = true;
      const typo = await postJson({ status: 'sould' });
      expect(typo.status).toBe(400);
      expect(typo.body).toMatchObject({ message: PUBLIC_ONLY_MESSAGE });

      const extra = await postJson({ status: 'rollback', extraCost: 1 });
      expect(extra.status).toBe(400);
      expect(String(extra.body.message)).toMatch(/^extraCost: /);
      expect(JSON.stringify(extra.body)).not.toMatch(/rollback/i);
      expectNoSideEffects();
    });

    it('rollback + proof -> 400 (avvalgidek), fayl yuklanmaydi', async () => {
      account.rollbackEnabled = true;
      const res = await postMultipart('rollback');
      expect(res.status).toBe(400);
      expect(fileClient.send).not.toHaveBeenCalled();
    });
  });

  it('⭐ toggle KEYINGI so‘rovdan kuchga kiradi (gateway keshlamaydi)', async () => {
    expect((await postJson({ status: 'rollback' })).status).toBe(400);
    account.rollbackEnabled = true;
    expect((await postJson({ status: 'rollback' })).status).toBe(200);
    account.rollbackEnabled = false;
    orderStatus = 'sold';
    expect((await postJson({ status: 'rollback' })).status).toBe(400);
    expect(integrationClient.send).toHaveBeenCalledTimes(3);
  });

  it('status pipe opsiyalari = main.ts dagi global UzValidationPipe opsiyalari', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const block = /new UzValidationPipe\(\{([\s\S]*?)\}\)/.exec(main)?.[1];
    expect(block).toBeDefined();
    const options = Object.fromEntries(
      [...(block ?? '').matchAll(/(\w+)\s*:\s*(true|false)/g)].map((m) => [
        m[1],
        m[2] === 'true',
      ]),
    );
    expect(options).toEqual(CARRIER_STATUS_PIPE_OPTIONS);
  });
});
