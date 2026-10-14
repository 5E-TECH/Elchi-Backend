import 'reflect-metadata';
import {
  ExecutionContext,
  GatewayTimeoutException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';
import { RMQ_GATEWAY_TIMEOUT } from '@app/common';
import { AiUsageGatewayController } from './ai-usage-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

/**
 * Celz3rKJ — `/ai-usage/*` ("Moliyaviy balans → AI xarajat" paneli):
 * HAQIQIY RolesGuard + main.ts dagi ValidationPipe bilan.
 * JwtAuthGuard o'rniga test guard: `x-test-user` JSON → `req.user`.
 */
describe('Celz3rKJ — AI xarajat paneli gateway (/ai-usage)', () => {
  let app: INestApplication;

  const AI_DASHBOARD = {
    from: '2026-10-01',
    to: '2026-10-14',
    usdUzsRate: 12800,
    summary: {
      totalCostUsd: 1.234567,
      totalCostUzs: 15802.46,
      totalCalls: 42,
      aiOrderCount: 7,
    },
    byFeature: [
      { feature: 'order_extract_multi', area: 'order', calls: 30 },
      { feature: 'order_district', area: 'order', calls: 12 },
    ],
    byModel: [],
    byArea: [],
    dailySeries: [],
  };
  const SOURCES = {
    internal: 20,
    external: 5,
    branch: 3,
    total: 28,
    applied_range: { clamped: false },
  };

  let aiReply: (pattern: { cmd: string }) => Observable<unknown>;
  let orderReply: (pattern: { cmd: string }) => Observable<unknown>;
  const ai = {
    send: jest.fn((...args: [{ cmd: string }, unknown]) => aiReply(args[0])),
  };
  const order = {
    send: jest.fn((...args: [{ cmd: string }, unknown]) => orderReply(args[0])),
  };

  const ADMIN = { sub: '1', roles: ['admin'] };
  const SUPERADMIN = { sub: '2', roles: ['superadmin'] };
  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AiUsageGatewayController],
      providers: [
        { provide: 'AI', useValue: ai },
        { provide: 'ORDER', useValue: order },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          const raw = req.headers['x-test-user'];
          if (raw) {
            req.user = JSON.parse(String(raw));
          }
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
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
    ai.send.mockClear();
    order.send.mockClear();
    aiReply = (p) =>
      of(
        p.cmd === 'ai.usage.ai_orders'
          ? {
              from: '2026-10-01',
              to: '2026-10-14',
              total: 2,
              limit: 100,
              items: [
                { orderId: '501', draftId: 'd1', draftCostUzs: 120 },
                { orderId: '502', draftId: 'd1', draftCostUzs: 120 },
              ],
            }
          : AI_DASHBOARD,
      );
    orderReply = (p) =>
      of(
        p.cmd === 'order.summary_by_ids'
          ? {
              statusCode: 200,
              data: [
                {
                  id: '501',
                  order_number: 9001,
                  status: 'new',
                  total_price: '150000',
                  customer_name: 'Ali',
                  customer_phone: '+998901234567',
                },
              ],
            }
          : SOURCES,
      );
  });

  // --- TC7: rol ---------------------------------------------------------

  it.each([
    ['market', ['market']],
    ['courier', ['courier']],
    ['operator', ['operator']],
    ['market_operator', ['market_operator']],
    ['investor', ['investor']],
    ['manager', ['manager']],
    ['registrator', ['registrator']],
    ['rollar bo`sh', []],
  ])(
    '⭐ TC7: %s → /ai-usage/dashboard va /ai-usage/ai-orders 403, servisga so`rov yo`q',
    async (_label, roles) => {
      for (const path of ['/ai-usage/dashboard', '/ai-usage/ai-orders']) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set(as({ sub: '9', roles }));
        expect(res.status).toBe(403);
      }
      expect(ai.send).not.toHaveBeenCalled();
      expect(order.send).not.toHaveBeenCalled();
    },
  );

  it('⭐ TC7: JWT foydalanuvchisi yo`q → 403', async () => {
    const res = await request(app.getHttpServer()).get('/ai-usage/dashboard');
    expect(res.status).toBe(403);
    expect(ai.send).not.toHaveBeenCalled();
  });

  // --- TC2 / TC4 / TC6 -----------------------------------------------------

  it.each([ADMIN, SUPERADMIN])(
    '⭐ TC2/TC4: %j → 200, summary.totalCostUsd / totalCostUzs, byFeature',
    async (user) => {
      const res = await request(app.getHttpServer())
        .get('/ai-usage/dashboard?fromDate=2026-10-01&toDate=2026-10-14')
        .set(as(user));
      expect(res.status).toBe(200);
      expect(res.body.data.summary.totalCostUsd).toBe(1.234567);
      expect(res.body.data.summary.totalCostUzs).toBe(15802.46);
      expect(res.body.data.byFeature.map((f: any) => f.feature)).toEqual([
        'order_extract_multi',
        'order_district',
      ]);
      expect(ai.send).toHaveBeenCalledWith(
        { cmd: 'ai.usage.dashboard' },
        { from: '2026-10-01', to: '2026-10-14' },
      );
    },
  );

  it('⭐ TC6: buyurtma manbasi — AI / qo`lda / tashqi / filial (qo`lda = internal − AI)', async () => {
    const res = await request(app.getHttpServer())
      .get('/ai-usage/dashboard?fromDate=2026-10-01&toDate=2026-10-14')
      .set(as(ADMIN));
    expect(res.body.data.orderSources).toEqual({
      total: 28,
      ai: 7,
      manual: 13,
      external: 5,
      branch: 3,
      applied_range: { clamped: false },
    });
    // AI xarajati bilan AYNI kunlar oynasi.
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.analytics.source_distribution' },
      { startDate: '2026-10-01', endDate: '2026-10-14' },
    );
    expect(res.body.data.degraded).toBe(false);
  });

  it('sana berilmasa — ikkala servisga ham AYNI oxirgi 30 kun (Toshkent)', async () => {
    // Faqat Date soxtalashtiriladi — supertest taymerlari haqiqiy qoladi.
    jest.useFakeTimers({
      now: new Date('2026-10-13T19:30:00.000Z'), // 14.10 00:30 Toshkent
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      await request(app.getHttpServer())
        .get('/ai-usage/dashboard')
        .set(as(ADMIN));
    } finally {
      jest.useRealTimers();
    }
    expect(ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.usage.dashboard' },
      { from: '2026-09-15', to: '2026-10-14' },
    );
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.analytics.source_distribution' },
      { startDate: '2026-09-15', endDate: '2026-10-14' },
    );
  });

  it('order-service javob bermasa — panel baribir, orderSources null + degraded', async () => {
    orderReply = () => throwError(() => new Error('timeout'));
    const res = await request(app.getHttpServer())
      .get('/ai-usage/dashboard')
      .set(as(ADMIN));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalCostUzs).toBe(15802.46);
    expect(res.body.data.orderSources).toBeNull();
    expect(res.body.data.degraded).toBe(true);
    expect(res.body.data.failed_parts).toEqual(['orderSources']);
  });

  it.each([
    ['fromDate=2026-10-15&toDate=2026-10-01'],
    ['fromDate=2026-13-01'],
    ['toDate=14.10.2026'],
    ['period=today'],
  ])('noto`g`ri so`rov %s → 400, servisga yetmaydi', async (qs) => {
    const res = await request(app.getHttpServer())
      .get(`/ai-usage/dashboard?${qs}`)
      .set(as(ADMIN));
    expect(res.status).toBe(400);
    expect(ai.send).not.toHaveBeenCalled();
  });

  it('ai-service timeout (rxjs TimeoutError) → 504', async () => {
    aiReply = () => throwError(() => new TimeoutError());
    const res = await request(app.getHttpServer())
      .get('/ai-usage/dashboard')
      .set(as(ADMIN));
    expect(res.status).toBe(504);
  });

  it('har send timeout(RMQ_GATEWAY_TIMEOUT) bilan — javobsiz ai-service 504 ga tushadi', async () => {
    // Haqiqiy taymer bilan (supertest fake timer bilan osilib qoladi):
    // controller to'g'ridan-to'g'ri chaqiriladi, `timeout` operatori ishlaydi.
    jest.useFakeTimers();
    try {
      const controller = new AiUsageGatewayController(
        { send: () => new Observable(() => undefined) } as never,
        { send: () => of(SOURCES) } as never,
      );
      const pending = controller
        .dashboard({ fromDate: '2026-10-01', toDate: '2026-10-14' })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await jest.advanceTimersByTimeAsync(RMQ_GATEWAY_TIMEOUT + 10);
      const err = await pending;
      expect(err).toBeInstanceOf(GatewayTimeoutException);
    } finally {
      jest.useRealTimers();
    }
  });

  // --- ai-orders ------------------------------------------------------------

  it('ai-orders: buyurtma raqami/holati/summasi qo`shiladi, mijoz telefoni/ismi YO`Q', async () => {
    const res = await request(app.getHttpServer())
      .get('/ai-usage/ai-orders?fromDate=2026-10-01&toDate=2026-10-14&limit=50')
      .set(as(ADMIN));
    expect(res.status).toBe(200);
    expect(ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.usage.ai_orders' },
      { from: '2026-10-01', to: '2026-10-14', limit: 50 },
    );
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.summary_by_ids' },
      { ids: ['501', '502'] },
    );
    expect(res.body.data.items).toEqual([
      {
        orderId: '501',
        draftId: 'd1',
        draftCostUzs: 120,
        orderNumber: 9001,
        status: 'new',
        totalPrice: 150000,
      },
      {
        orderId: '502',
        draftId: 'd1',
        draftCostUzs: 120,
        orderNumber: null,
        status: null,
        totalPrice: null,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('+998901234567');
    expect(res.body.data.degraded).toBe(false);
  });

  it.each([['limit=0'], ['limit=101'], ['limit=abc']])(
    'ai-orders %s → 400',
    async (qs) => {
      const res = await request(app.getHttpServer())
        .get(`/ai-usage/ai-orders?${qs}`)
        .set(as(ADMIN));
      expect(res.status).toBe(400);
      expect(ai.send).not.toHaveBeenCalled();
    },
  );
});
