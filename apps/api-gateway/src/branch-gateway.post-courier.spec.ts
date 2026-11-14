import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NEVER, Observable, of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { BranchGatewayController } from './branch-gateway.controller';

/**
 * POCHTA → HQ KURYERI (ega qarori 2026-11-15) — gateway:
 *   GET  /branches/posts/:postId/courier-destinations → logistics.post.courier_destinations
 *        + integration.carrier.find_by_courier_ids (yumshoq, 3 s)
 *   POST /branches/posts/:postId/dispatch-to-courier  → logistics.post.dispatch_to_courier
 *   PATCH /couriers/:id/branch — carrier kuryeri HQ'dan chiqmaydi (B6).
 * HAQIQIY Nest routeri, HAQIQIY RolesGuard, global ValidationPipe va filtrlar.
 */
type Row = Record<string, unknown>;

const roleUser = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'] ?? 'superadmin';
    req.user = { sub: '7', username: 'u', roles: [role] };
    return true;
  },
};

const destinationsBody = () => ({
  statusCode: 200,
  message: 'HQ couriers for post region',
  data: {
    post_id: '123',
    region_id: '5',
    is_hq_region: false,
    couriers: [
      {
        courier_user_id: '77',
        name: 'Ali Valiyev',
        phone: '+998901234567',
        region_match: 'listed',
      },
      {
        courier_user_id: '78',
        name: 'Vali',
        phone: null,
        region_match: 'all_regions',
      },
    ],
  },
});

describe('BranchGatewayController — Pochta → HQ kuryeri (HTTP)', () => {
  let app: INestApplication;
  const branchSend = jest.fn();
  const logisticsSend = jest.fn();
  const integrationSend = jest.fn();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BranchGatewayController],
      providers: [
        { provide: 'BRANCH', useValue: { send: branchSend } },
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'INTEGRATION', useValue: { send: integrationSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(roleUser)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    branchSend.mockReset();
    logisticsSend.mockReset();
    integrationSend.mockReset();
    logisticsSend.mockReturnValue(of(destinationsBody()));
    integrationSend.mockReturnValue(
      of({
        statusCode: 200,
        data: [{ courier_user_id: '77', name: 'BeePost', is_active: true }],
      }),
    );
    branchSend.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  describe('GET /branches/posts/:postId/courier-destinations', () => {
    it('⭐ logistics ro‘yxati + carrier belgisi (carrier_name / carrier_active; bog‘lanmagan — null)', async () => {
      const res = await request(http()).get(
        '/branches/posts/123/courier-destinations',
      );

      expect(res.status).toBe(200);
      expect(logisticsSend).toHaveBeenCalledWith(
        { cmd: 'logistics.post.courier_destinations' },
        { post_id: '123', requester: { id: '7', roles: ['superadmin'] } },
      );
      expect(integrationSend).toHaveBeenCalledWith(
        { cmd: 'integration.carrier.find_by_courier_ids' },
        { courier_ids: ['77', '78'] },
      );
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'HQ couriers for post region',
        data: {
          post_id: '123',
          region_id: '5',
          is_hq_region: false,
          couriers: [
            {
              courier_user_id: '77',
              name: 'Ali Valiyev',
              phone: '+998901234567',
              region_match: 'listed',
              carrier_name: 'BeePost',
              carrier_active: true,
            },
            {
              courier_user_id: '78',
              name: 'Vali',
              phone: null,
              region_match: 'all_regions',
              carrier_name: null,
              carrier_active: null,
            },
          ],
          carrier_lookup_failed: false,
        },
      });
      expect(branchSend).not.toHaveBeenCalled();
    });

    it('⭐ integration javob bermadi — ro‘yxat baribir 200, carrier_* null, carrier_lookup_failed: true', async () => {
      integrationSend.mockReturnValue(throwError(() => new TimeoutError()));

      const res = await request(http()).get(
        '/branches/posts/123/courier-destinations',
      );

      expect(res.status).toBe(200);
      const body = res.body as { data: Row & { couriers: Row[] } };
      expect(body.data.carrier_lookup_failed).toBe(true);
      expect(
        body.data.couriers.map((c) => [c.carrier_name, c.carrier_active]),
      ).toEqual([
        [null, null],
        [null, null],
      ]);
    });

    it('kuryer yo‘q — integration’ga bormaydi', async () => {
      logisticsSend.mockReturnValue(
        of({
          ...destinationsBody(),
          data: { ...destinationsBody().data, couriers: [] },
        }),
      );

      const res = await request(http()).get(
        '/branches/posts/123/courier-destinations',
      );

      expect(res.status).toBe(200);
      expect((res.body as { data: Row }).data).toMatchObject({
        couriers: [],
        carrier_lookup_failed: false,
      });
      expect(integrationSend).not.toHaveBeenCalled();
    });

    it('logistics rad javobi (400 post_not_sendable) — kod, xabar va data.reason/details o‘zgarmaydi', async () => {
      logisticsSend.mockReturnValue(
        throwError(() => ({
          statusCode: 400,
          message:
            "Pochta #123 kuryerga berilmaydi: faqat yangi ('new'), kuryersiz HQ pochtasi beriladi",
          data: {
            post_id: '123',
            reason: 'post_not_sendable',
            details: {
              post_id: '123',
              post_status: 'sent',
              post_courier_id: '0',
            },
          },
        })),
      );

      const res = await request(http()).get(
        '/branches/posts/123/courier-destinations',
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        data: {
          reason: 'post_not_sendable',
          details: {
            post_id: '123',
            post_status: 'sent',
            post_courier_id: '0',
          },
        },
      });
      expect(integrationSend).not.toHaveBeenCalled();
    });

    it.each(['abc', '1.5', '-1'])(
      'postId %s — 400, RPC yo‘q',
      async (postId) => {
        const res = await request(http()).get(
          `/branches/posts/${postId}/courier-destinations`,
        );

        expect(res.status).toBe(400);
        expect(logisticsSend).not.toHaveBeenCalled();
      },
    );

    it.each(['manager', 'branch', 'courier', 'market'])(
      '⭐ %s — 403 (RolesGuard), RPC yo‘q',
      async (role) => {
        const res = await request(http())
          .get('/branches/posts/123/courier-destinations')
          .set('x-test-role', role);

        expect(res.status).toBe(403);
        expect(logisticsSend).not.toHaveBeenCalled();
      },
    );

    it.each(['superadmin', 'admin', 'registrator'])(
      '%s — o‘tadi (HQ tekshiruvi logistics’da)',
      async (role) => {
        const res = await request(http())
          .get('/branches/posts/123/courier-destinations')
          .set('x-test-role', role);

        expect(res.status).toBe(200);
      },
    );
  });

  describe('POST /branches/posts/:postId/dispatch-to-courier', () => {
    const okBody = {
      statusCode: 200,
      message: 'Pochta buyurtmalari kuryerga berildi',
      data: {
        post_id: '123',
        courier_id: '77',
        courier_post_id: '456',
        courier_post_created: true,
        moved_order_ids: ['101', '102'],
        moved_orders_count: 2,
        skipped_order_ids: [],
        post_deleted: false,
      },
    };

    it('⭐ logistics.post.dispatch_to_courier {post_id, courier_id, order_ids, requester}; javob o‘zgarmaydi', async () => {
      logisticsSend.mockReturnValue(of(okBody));

      const res = await request(http())
        .post('/branches/posts/123/dispatch-to-courier')
        .set('x-test-role', 'registrator')
        .send({ courier_id: '77', order_ids: ['101', ' 0102 '] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(okBody);
      expect(logisticsSend).toHaveBeenCalledTimes(1);
      expect(logisticsSend).toHaveBeenCalledWith(
        { cmd: 'logistics.post.dispatch_to_courier' },
        {
          post_id: '123',
          courier_id: '77',
          order_ids: ['101', '102'],
          requester: { id: '7', roles: ['registrator'] },
        },
      );
      // Filial jo'natmasi (branch.post.dispatch) chaqirilmaydi.
      expect(branchSend).not.toHaveBeenCalled();
    });

    it.each([
      ['courier_id yo‘q', { order_ids: ['101'] }, "courier_id noto'g'ri"],
      [
        'courier_id son',
        { courier_id: 77, order_ids: ['101'] },
        "courier_id noto'g'ri",
      ],
      [
        'courier_id 0',
        { courier_id: '0', order_ids: ['101'] },
        "courier_id noto'g'ri",
      ],
      ['order_ids yo‘q', { courier_id: '77' }, 'order_ids majburiy'],
      [
        'order_ids bo‘sh',
        { courier_id: '77', order_ids: [] },
        'order_ids majburiy',
      ],
      [
        'order_ids satr',
        { courier_id: '77', order_ids: '101' },
        'order_ids majburiy',
      ],
      [
        'order_ids ichida son',
        { courier_id: '77', order_ids: [101] },
        'order_ids majburiy',
      ],
      [
        'order_ids ichida 1.5',
        { courier_id: '77', order_ids: ['1.5'] },
        'order_ids majburiy',
      ],
      [
        'order_ids BIGINT’dan katta',
        { courier_id: '77', order_ids: ['9223372036854775808'] },
        'order_ids majburiy',
      ],
      [
        'order_ids 1000 tadan ko‘p',
        {
          courier_id: '77',
          order_ids: Array.from({ length: 1001 }, (_, i) => String(i + 1)),
        },
        'order_ids majburiy',
      ],
    ])('⭐ tana: %s — 400, RPC yo‘q', async (_label, payload, message) => {
      const res = await request(http())
        .post('/branches/posts/123/dispatch-to-courier')
        .send(payload);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(message);
      expect(logisticsSend).not.toHaveBeenCalled();
    });

    it('1000 ta buyurtma — chegarada o‘tadi', async () => {
      logisticsSend.mockReturnValue(of(okBody));

      const res = await request(http())
        .post('/branches/posts/123/dispatch-to-courier')
        .send({
          courier_id: '77',
          order_ids: Array.from({ length: 1000 }, (_, i) => String(i + 1)),
        });

      expect(res.status).toBe(201);
    });

    it.each([
      [409, 'order_not_in_post', { order_ids: ['999'] }],
      [
        403,
        'courier_region_not_served',
        { courier_id: '77', post_region_id: '5' },
      ],
      [400, 'courier_not_hq', { courier_id: '77' }],
    ])(
      'logistics rad javobi %s %s — kod va data o‘zgarmaydi',
      async (statusCode, reason, details) => {
        logisticsSend.mockReturnValue(
          throwError(() => ({
            statusCode,
            message: 'rad',
            data: { ...details, reason, details },
          })),
        );

        const res = await request(http())
          .post('/branches/posts/123/dispatch-to-courier')
          .send({ courier_id: '77', order_ids: ['101'] });

        expect(res.status).toBe(statusCode);
        expect((res.body as { data: Row }).data).toEqual({ reason, details });
      },
    );

    it.each(['manager', 'branch', 'courier'])(
      '⭐ %s — 403 (RolesGuard), RPC yo‘q',
      async (role) => {
        const res = await request(http())
          .post('/branches/posts/123/dispatch-to-courier')
          .set('x-test-role', role)
          .send({ courier_id: '77', order_ids: ['101'] });

        expect(res.status).toBe(403);
        expect(logisticsSend).not.toHaveBeenCalled();
      },
    );
  });

  describe('PATCH /couriers/:id/branch — carrier kuryeri faqat HQ’da (B6)', () => {
    const transferOk = {
      statusCode: 200,
      message: "Kuryer o'tkazildi",
      data: { user_id: '5' },
    };
    const branchRoutes = (hqId: unknown = '1') =>
      branchSend.mockImplementation((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_hq'
          ? of({ statusCode: 200, data: { id: hqId } })
          : of(transferOk),
      );

    it('⭐ bog‘langan kuryerni boshqa filialga — 409 courier_carrier_linked, o‘tkazish RPC’si YO‘Q', async () => {
      integrationSend.mockReturnValue(
        of({
          data: [{ courier_user_id: '5', name: 'BeePost', is_active: true }],
        }),
      );
      branchRoutes();

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message:
          "Kuryer «BeePost» tashqi yetkazuvchisiga bog'langan — u faqat HQ'da bo'ladi",
        data: {
          reason: 'courier_carrier_linked',
          details: { courier_id: '5' },
        },
      });
      expect(integrationSend).toHaveBeenCalledWith(
        { cmd: 'integration.carrier.find_by_courier_ids' },
        { courier_ids: ['5'] },
      );
      expect(
        branchSend.mock.calls.map(([p]) => (p as { cmd: string }).cmd),
      ).toEqual(['branch.find_hq']);
    });

    it('bog‘langan kuryerni HQ’ga (o‘sha HQ) — o‘tkazish davom etadi', async () => {
      integrationSend.mockReturnValue(
        of({
          data: [{ courier_user_id: '5', name: 'BeePost', is_active: true }],
        }),
      );
      branchRoutes('15');

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '015' });

      expect(res.status).toBe(200);
      expect(branchSend).toHaveBeenCalledWith(
        { cmd: 'branch.user.transfer_courier' },
        expect.objectContaining({ user_id: '5', branch_id: '015' }),
      );
    });

    it('bog‘lanmagan kuryer — HQ so‘ralmaydi, o‘tkazish avvalgidek', async () => {
      integrationSend.mockReturnValue(of({ statusCode: 200, data: [] }));
      branchRoutes();

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(transferOk);
      expect(
        branchSend.mock.calls.map(([p]) => (p as { cmd: string }).cmd),
      ).toEqual(['branch.user.transfer_courier']);
    });

    it('⭐ integration javob bermadi — 503, o‘tkazish RPC’si YO‘Q (fail closed)', async () => {
      integrationSend.mockReturnValue(throwError(() => new TimeoutError()));
      branchRoutes();

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(503);
      expect((res.body as { message: string }).message).toContain(
        "tashqi yetkazuvchiga bog'lanishini tekshirib bo'lmadi",
      );
      expect(branchSend).not.toHaveBeenCalled();
    });

    it('integration noto‘g‘ri javob qaytardi (data massiv emas) — «bog‘lanmagan» EMAS, 503', async () => {
      integrationSend.mockReturnValue(of({ statusCode: 200, data: null }));
      branchRoutes();

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(503);
      expect(branchSend).not.toHaveBeenCalled();
    });

    it('bog‘langan kuryer, branch.find_hq javob bermadi — 503', async () => {
      integrationSend.mockReturnValue(
        of({
          data: [{ courier_user_id: '5', name: 'BeePost', is_active: true }],
        }),
      );
      branchSend.mockImplementation((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_hq'
          ? throwError(() => ({ statusCode: 500, message: 'down' }))
          : of(transferOk),
      );

      const res = await request(http())
        .patch('/couriers/5/branch')
        .send({ branch_id: '15' });

      expect(res.status).toBe(503);
      expect(
        branchSend.mock.calls.map(([p]) => (p as { cmd: string }).cmd),
      ).toEqual(['branch.find_hq']);
    });
  });
});

describe('BranchGatewayController — Pochta → HQ kuryeri: mijozlar yo‘q', () => {
  const req = { user: { sub: '1', roles: ['superadmin'] } };

  it('LOGISTICS mijozi yo‘q — 503 (ikkala marshrut)', async () => {
    const controller = new BranchGatewayController({
      send: jest.fn(),
    } as never);

    await expect(
      controller.findPostCourierDestinations('123', req),
    ).rejects.toMatchObject({ status: 503 });
    expect(() =>
      controller.dispatchPostToCourier('123', '77', ['101'], req),
    ).toThrow(/Logistika xizmati mavjud emas/);
  });

  it('INTEGRATION mijozi yo‘q — ro‘yxat baribir qaytadi, carrier_lookup_failed: true', async () => {
    const logistics = { send: jest.fn(() => of(destinationsBody())) };
    const controller = new BranchGatewayController(
      { send: jest.fn() } as never,
      undefined,
      undefined,
      logistics as never,
    );

    const res = (await controller.findPostCourierDestinations('123', req)) as {
      data: Row & { couriers: Row[] };
    };

    expect(res.data.carrier_lookup_failed).toBe(true);
    expect(res.data.couriers[0]).toMatchObject({
      carrier_name: null,
      carrier_active: null,
    });
  });

  it('INTEGRATION mijozi yo‘q — kuryer o‘tkazish 503 (to‘siqni tekshirib bo‘lmaydi)', () => {
    const branch = { send: jest.fn(() => of({})) };
    const controller = new BranchGatewayController(branch as never);

    let error: unknown;
    controller
      .transferCourierBranch('5', { branch_id: '15' }, req)
      .subscribe({ error: (e: unknown) => (error = e) });

    expect(error).toMatchObject({ status: 503 });
    expect(branch.send).not.toHaveBeenCalled();
  });
});

describe('BranchGatewayController — Pochta → HQ kuryeri: rollar va timeout’lar', () => {
  const rolesOf = (method: keyof BranchGatewayController) =>
    Reflect.getMetadata(
      ROLES_KEY,
      Object.getOwnPropertyDescriptor(BranchGatewayController.prototype, method)
        ?.value,
    ) as string[];

  it.each([
    ['findPostCourierDestinations'],
    ['dispatchPostToCourier'],
  ] as const)(
    '%s — superadmin, admin, registrator (menejer / filial / kuryer YO‘Q)',
    (method) => {
      expect(rolesOf(method)).toEqual(['superadmin', 'admin', 'registrator']);
    },
  );

  const req = { user: { sub: '1', roles: ['superadmin'] } };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const timesOutAt = (observable: Observable<unknown>, ms: number) => {
    let error: unknown;
    const subscription = observable.subscribe({
      error: (e: unknown) => {
        error = e;
      },
    });
    jest.advanceTimersByTime(ms - 1);
    const early = error;
    jest.advanceTimersByTime(1);
    subscription.unsubscribe();
    return { early, late: error };
  };

  it('dispatch-to-courier — timeout aynan 120 000 ms (paket amallari kabi)', () => {
    const controller = new BranchGatewayController(
      { send: jest.fn() } as never,
      undefined,
      undefined,
      { send: jest.fn(() => NEVER) } as never,
    );

    const { early, late } = timesOutAt(
      controller.dispatchPostToCourier('123', '77', ['101'], req),
      120_000,
    );

    expect(early).toBeUndefined();
    expect(late).toBeInstanceOf(TimeoutError);
  });

  it('courier-destinations — logistics 15 s da uziladi (504)', async () => {
    const controller = new BranchGatewayController(
      { send: jest.fn() } as never,
      undefined,
      undefined,
      { send: jest.fn(() => NEVER) } as never,
    );

    const promise = controller.findPostCourierDestinations('123', req);
    const settled = jest.fn();
    promise.catch(settled);
    jest.advanceTimersByTime(14_999);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
  });

  it('carrier belgisi integration’ni 3 s dan ortiq kutmaydi', async () => {
    const controller = new BranchGatewayController(
      { send: jest.fn() } as never,
      undefined,
      undefined,
      { send: jest.fn(() => of(destinationsBody())) } as never,
      { send: jest.fn(() => NEVER) } as never,
    );

    const promise = controller.findPostCourierDestinations('123', req);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    const res = (await promise) as { data: Row };
    expect(res.data.carrier_lookup_failed).toBe(true);
  });
});
