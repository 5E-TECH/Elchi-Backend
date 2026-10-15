import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter, Roles as RoleEnum } from '@app/common';
import { throwError, of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * yokjwjXG — `POST /post/delete` (superadmin pochta detalidagi savat).
 *
 * HAQIQIY Nest routeri + HAQIQIY RolesGuard + gateway'ning global
 * ValidationPipe opsiyalari (whitelist/forbidNonWhitelisted/transform) va
 * AllExceptionsFilter. Faqat JwtAuthGuard almashtiriladi (token o'rniga
 * `user` qo'yadi).
 */
describe('yokjwjXG — POST /post/delete (gateway)', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const logisticsSend = jest.fn(() => of({ statusCode: 200, data: {} }));
  const identitySend = jest.fn(() => of({ statusCode: 200, data: [] }));
  let user: { sub: string; roles: string[] } | null = {
    sub: '1',
    roles: [RoleEnum.SUPERADMIN],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'ORDER', useValue: { send: orderSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
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
    app.useGlobalInterceptors(new BodyStatusCodeInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const okBody = {
    statusCode: 200,
    message: "2 ta buyurtma pochtadan o'chirildi",
    data: {
      post_id: '88',
      deleted: ['700', '701'],
      skipped: [],
      post_deleted: false,
      order_quantity: 3,
      post_total_price: 450000,
    },
  };

  beforeEach(() => {
    orderSend.mockReset();
    orderSend.mockReturnValue(of(okBody));
    logisticsSend.mockClear();
    user = { sub: '1', roles: [RoleEnum.SUPERADMIN] };
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const valid = {
    post_id: '88',
    order_ids: ['700', '701'],
    reason: '  Market posilkani qaytarib oldi  ',
  };

  it('⭐ superadmin → 200, order.post.delete_orders ga trim qilingan sabab va requester bilan boradi', async () => {
    const res = await request(http()).post('/post/delete').send(valid);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(okBody);
    expect(orderSend).toHaveBeenCalledTimes(1);
    expect(orderSend).toHaveBeenCalledWith(
      { cmd: 'order.post.delete_orders' },
      {
        post_id: '88',
        order_ids: ['700', '701'],
        reason: 'Market posilkani qaytarib oldi',
        requester: { id: '1', roles: [RoleEnum.SUPERADMIN] },
      },
    );
    // Logistics'ga umuman bormaydi (o'chirish order-service tranzaksiyasida).
    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it('JSON son id lar satrga keltiriladi', async () => {
    const res = await request(http())
      .post('/post/delete')
      .send({ post_id: 88, order_ids: [700], reason: 'abc' });

    expect(res.status).toBe(200);
    expect(orderSend.mock.calls[0][1]).toMatchObject({
      post_id: '88',
      order_ids: ['700'],
      reason: 'abc',
    });
  });

  it.each([
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.REGISTRATOR,
    RoleEnum.BRANCH,
  ])('⭐ %s → 403, order-service chaqirilmaydi', async (role) => {
    user = { sub: '5', roles: [role] };
    const res = await request(http()).post('/post/delete').send(valid);

    expect(res.status).toBe(403);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["post_id yo'q", { order_ids: ['700'], reason: 'abc' }],
    ['post_id = "0"', { post_id: '0', order_ids: ['700'], reason: 'abc' }],
    ['post_id manfiy', { post_id: '-3', order_ids: ['700'], reason: 'abc' }],
    ['post_id kasr', { post_id: '1.5', order_ids: ['700'], reason: 'abc' }],
    ['post_id matn', { post_id: 'abc', order_ids: ['700'], reason: 'abc' }],
    ["order_ids yo'q", { post_id: '88', reason: 'abc' }],
    ["order_ids bo'sh", { post_id: '88', order_ids: [], reason: 'abc' }],
    [
      'order_ids massiv emas',
      { post_id: '88', order_ids: '700', reason: 'abc' },
    ],
    [
      'order_ids > 100',
      {
        post_id: '88',
        order_ids: Array.from({ length: 101 }, (_, i) => String(i + 1)),
        reason: 'abc',
      },
    ],
    [
      'order_ids takrorlangan',
      { post_id: '88', order_ids: ['700', '700'], reason: 'abc' },
    ],
    [
      'order_ids son va satr takrori',
      { post_id: '88', order_ids: ['700', 700], reason: 'abc' },
    ],
    [
      'order_ids ichida 0',
      { post_id: '88', order_ids: ['700', '0'], reason: 'abc' },
    ],
    [
      'order_ids ichida matn',
      { post_id: '88', order_ids: ['x1'], reason: 'abc' },
    ],
    ["reason yo'q", { post_id: '88', order_ids: ['700'] }],
    [
      'reason trimdan keyin < 3',
      { post_id: '88', order_ids: ['700'], reason: '   ab   ' },
    ],
    [
      'reason > 500',
      { post_id: '88', order_ids: ['700'], reason: 'a'.repeat(501) },
    ],
    ['reason son', { post_id: '88', order_ids: ['700'], reason: 12345 }],
    [
      "noma'lum maydon",
      { post_id: '88', order_ids: ['700'], reason: 'abc', force: true },
    ],
  ])('⭐ 400: %s', async (_label, body) => {
    const res = await request(http()).post('/post/delete').send(body);

    expect(res.status).toBe(400);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('100 ta (chegara) buyurtma va 500 belgili sabab — qabul qilinadi', async () => {
    const res = await request(http())
      .post('/post/delete')
      .send({
        post_id: '88',
        order_ids: Array.from({ length: 100 }, (_, i) => String(i + 1)),
        reason: 'a'.repeat(500),
      });

    expect(res.status).toBe(200);
  });

  it("order-service 409 (to'siq ro'yxati) → HTTP 409, xabar o'zgarmaydi", async () => {
    const message =
      "1 ta buyurtmani pochtadan o'chirib bo'lmaydi: #700 — kuryer qo'lida. Hech narsa o'zgarmadi";
    orderSend.mockReturnValue(throwError(() => ({ statusCode: 409, message })));

    const res = await request(http()).post('/post/delete').send(valid);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(message);
  });

  it('marshrut: POST post/delete, statik — boshqa POST post/:param marshruti uni yutmaydi', () => {
    const proto = LogisticsGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    const handler = proto.deletePostOrders as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('post/delete');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );

    const postPaths = Object.getOwnPropertyNames(proto)
      .map((name) => proto[name])
      .filter((fn): fn is object => typeof fn === 'function')
      .filter(
        (fn) => Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.POST,
      )
      .map((fn) => String(Reflect.getMetadata(PATH_METADATA, fn)));
    const shadowing = postPaths.filter((path) => {
      if (path === 'post/delete' || !path.includes(':')) return false;
      const pattern = new RegExp(
        `^${path.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/')}$`,
      );
      return pattern.test('post/delete');
    });
    expect(shadowing).toEqual([]);
  });

  it("ORDER mijozi bo'lmasa (eski qurilish) — 503, logistics'ga tushmaydi", async () => {
    const controller = new LogisticsGatewayController(
      { send: logisticsSend } as never,
      { send: identitySend } as never,
    );
    await expect(
      controller.deletePostOrders(
        { post_id: '88', order_ids: ['700'], reason: 'abc' },
        { user: { sub: '1', roles: [RoleEnum.SUPERADMIN] } },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(logisticsSend).not.toHaveBeenCalled();
  });
});
