import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import {
  AllExceptionsFilter,
  ORDER_INTAKE_CLOSED,
  ORDER_INTAKE_RPC,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { OrderGatewayController } from './order-gateway.controller';
import { UzValidationPipe } from './validation/uz-validation.pipe';
import { toConfirmFailure } from './ai-order/ai-order.helpers';

/**
 * BUGUNGI QABUL VAQTI (ega 2026-11-09) — gateway:
 *  • `GET|PATCH /orders/intake-settings` `:id` marshrutlaridan OLDIN;
 *  • PATCH — FAQAT SUPERADMIN, `HH:MM` yoki `null`;
 *  • yopiq qabulda order-service 409 `ORDER_INTAKE_CLOSED` FE'ga
 *    o'zgarishsiz yetadi (darvoza order-service'da);
 *  • ai-confirm natijasi — `intake_closed` (aniq sabab).
 */

const CLOSED_ERROR = {
  statusCode: 409,
  message:
    'Bugungi buyurtma qabuli yopilgan (10:00 gacha edi). Yangi buyurtmani kun almashgach — 10.11.2026 00:00 dan yaratish mumkin',
  code: ORDER_INTAKE_CLOSED,
  reopens_at: '2026-11-09T19:00:00.000Z',
  cutoff_time: '10:00',
};

describe('OrderGatewayController — bugungi qabul vaqti (HTTP)', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };
  let user: { sub: string; roles: string[] } = {
    sub: '1',
    roles: ['superadmin'],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
        { provide: 'FILE', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
          return true;
        },
      })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new UzValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    orderSend.mockReset();
    orderSend.mockReturnValue(
      of({ statusCode: 200, message: 'success', data: { is_open: true } }),
    );
    user = { sub: '1', roles: ['superadmin'] };
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const calls = () =>
    orderSend.mock.calls as Array<[{ cmd: string }, Record<string, unknown>]>;

  it.each(['courier', 'market', 'manager', 'customer'])(
    'GET — har rol (%s) holatni o`qiydi, `:id` ga TUSHMAYDI',
    async (role) => {
      user = { sub: '7', roles: [role] };
      const res = await request(http()).get('/orders/intake-settings');
      expect(res.status).toBe(200);
      expect(calls().map(([p]) => p.cmd)).toEqual([ORDER_INTAKE_RPC.STATE]);
    },
  );

  it('PATCH superadmin `{cutoff_time:"10:00"}` → order.intake.update + requester', async () => {
    const res = await request(http())
      .patch('/orders/intake-settings')
      .send({ cutoff_time: '10:00' });
    expect(res.status).toBe(200);
    expect(calls()).toEqual([
      [
        { cmd: ORDER_INTAKE_RPC.UPDATE },
        { cutoff_time: '10:00', requester: { id: '1', roles: ['superadmin'] } },
      ],
    ]);
  });

  it('PATCH `null` — cheklovni olib tashlash sifatida uzatiladi', async () => {
    await request(http())
      .patch('/orders/intake-settings')
      .send({ cutoff_time: null, day_change_time: '06:00' });
    expect(calls()[0][1]).toEqual({
      cutoff_time: null,
      day_change_time: '06:00',
      requester: { id: '1', roles: ['superadmin'] },
    });
  });

  it('PATCH — yuborilmagan maydon uzatilmaydi (o`zgarmaydi)', async () => {
    await request(http())
      .patch('/orders/intake-settings')
      .send({ day_change_time: '18:00' });
    expect(calls()[0][1]).not.toHaveProperty('cutoff_time');
  });

  it.each(['admin', 'registrator', 'manager', 'market'])(
    'PATCH %s — 403, order-service chaqirilmaydi',
    async (role) => {
      user = { sub: '2', roles: [role] };
      const res = await request(http())
        .patch('/orders/intake-settings')
        .send({ cutoff_time: '10:00' });
      expect(res.status).toBe(403);
      expect(orderSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ cutoff_time: '25:00' }],
    [{ cutoff_time: '9:00' }],
    [{ cutoff_time: 600 }],
    [{ day_change_time: 'kech' }],
    [{ cutoff_time: '10:00', extra: true }],
  ])('PATCH yaroqsiz tana %p — 400', async (body) => {
    const res = await request(http())
      .patch('/orders/intake-settings')
      .send(body);
    expect(res.status).toBe(400);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('PATCH roli metadata — faqat superadmin', () => {
    const handler: unknown = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'updateIntakeSettings',
    )?.value;
    const roles = Reflect.getMetadata(ROLES_KEY, handler as object) as
      string[] | undefined;
    expect(roles).toEqual(['superadmin']);
  });
});

describe('POST /orders — order-service 409 o`zgarishsiz yetib boradi', () => {
  function makeController() {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'order.create'
          ? throwError(() => CLOSED_ERROR)
          : of({ statusCode: 200, data: {} }),
      ),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'identity.market.find_by_id') {
          return of({ data: { id: '16', status: 'active', add_order: true } });
        }
        if (pattern.cmd === 'identity.customer.create') {
          return of({ data: { id: 'c-1' } });
        }
        return of({});
      }),
    };
    const controller = new OrderGatewayController(
      orderClient as never,
      identityClient as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({ data: null })) } as never,
      undefined,
      undefined,
      { send: jest.fn(() => of({ data: [] })) } as never,
    );
    return { controller, orderClient };
  }

  it('yopiq — 409 ORDER_INTAKE_CLOSED (`reopens_at`, `cutoff_time`) FE`ga', async () => {
    const { controller, orderClient } = makeController();
    const req = { user: { sub: '1', username: 'u', roles: ['superadmin'] } };
    await expect(
      controller.create(
        {
          market_id: '16',
          customer: {
            name: 'TEST',
            phone_number: '+998887009201',
            district_id: '173',
          },
          district_id: '173',
          total_price: 100000,
          items: [{ product_name: 'Kitob', quantity: 1 }],
        } as never,
        req,
      ),
    ).rejects.toEqual(CLOSED_ERROR);
    expect(
      orderClient.send.mock.calls.filter(
        (c: Array<{ cmd: string }>) => c[0]?.cmd === 'order.create',
      ),
    ).toHaveLength(1);
  });
});

describe('ai-confirm — toConfirmFailure: intake_closed', () => {
  it('yopiq qabul xatosi aniq sabab bilan qaytadi', () => {
    expect(toConfirmFailure(CLOSED_ERROR)).toEqual({
      code: 'intake_closed',
      reason: CLOSED_ERROR.message,
    });
  });

  it('boshqa 409 (telefon) — avvalgidek create_failed', () => {
    expect(
      toConfirmFailure({
        statusCode: 409,
        message: 'Bu telefon raqam boshqa rolda allaqachon mavjud',
      }).code,
    ).toBe('create_failed');
  });
});
