import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * anKpzwxk (ega qarori 7, 2026-11-03) — BEGONA QR:
 * `GET /orders/qr-code/:token` (to'liq va `?view=light`).
 *
 * Filial xodimi / HQ bo'lmagan filial kuryeri o'z filialida bo'lmagan
 * buyurtmani so'rasa — 403 «Bu buyurtma sizning filialingizda emas»,
 * `data.reason` order_not_in_your_branch, buyurtma ma'lumotisiz.
 * SA/admin, HQ xodimi — cheklanmaydi; market qoidasi (C11) o'zgarmagan.
 */
type Handlers = Record<string, unknown>;

const HQ_BRANCH_ID = '1';
const OWN_BRANCH_ID = '5';
const FOREIGN_BRANCH_ID = '6';

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      if (handler instanceof Error) {
        return throwError(() => handler);
      }
      const value =
        typeof handler === 'function'
          ? (handler as (p: unknown) => unknown)(payload)
          : handler;
      return of(value ?? { statusCode: 200, data: null });
    }),
  };
}

function setup(opts: { order?: Handlers; branch?: Handlers } = {}) {
  const order = makeClient(opts.order);
  const identity = makeClient();
  const logistics = makeClient();
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: HQ_BRANCH_ID } },
    ...opts.branch,
  });
  const controller = new OrderGatewayController(
    order as any,
    identity as any,
    logistics as any,
    branch as any,
  );
  return { controller, order, branch };
}

const cmds = (client: { send: jest.Mock }) =>
  (client.send.mock.calls as unknown[][]).map(
    (args) => (args[0] as { cmd: string }).cmd,
  );

const user = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as any;

/** To'liq buyurtma — mijoz, manzil, summa bilan (rad etilsa chiqmasligi kerak). */
const fullOrder = (overrides: Record<string, unknown> = {}) => ({
  id: '77',
  market_id: '201',
  branch_id: OWN_BRANCH_ID,
  holder_branch_id: OWN_BRANCH_ID,
  holder_courier_id: null,
  courier_id: null,
  current_batch_id: null,
  total_price: 150000,
  address: 'Urgut, Mustaqillik 1',
  customer: { id: '9', name: 'Mijoz', phone_number: '+998901234567' },
  ...overrides,
});

const qr = (data: Record<string, unknown>) => ({
  'order.find_by_qr_enriched': { statusCode: 200, data },
  'order.find_by_qr': { statusCode: 200, data },
});

const LIGHT = {
  statusCode: 200,
  data: {
    id: '77',
    market_id: '201',
    total_price: 150000,
    address: 'Urgut, Mustaqillik 1',
  },
};

const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('kutilgan rad etish yo`q');
    },
    (error: unknown) => error,
  );

describe('anKpzwxk — GET /orders/qr-code/:token begona filial (to`liq javob)', () => {
  it('MENEJER: o`z filiali buyurtmasi -> ko`rinadi', async () => {
    const { controller } = setup({ order: qr(fullOrder()) });
    await expect(
      controller.findByQrCode('ORD-x', user('50', ['manager'], OWN_BRANCH_ID)),
    ).resolves.toMatchObject({ data: { id: '77' } });
  });

  it.each([['manager'], ['registrator'], ['branch']])(
    '%s: begona filial buyurtmasi -> 403 order_not_in_your_branch, ma`lumotsiz',
    async (role) => {
      const { controller } = setup({
        order: qr(
          fullOrder({
            branch_id: FOREIGN_BRANCH_ID,
            holder_branch_id: FOREIGN_BRANCH_ID,
          }),
        ),
      });
      const error = await rejection(
        controller.findByQrCode('ORD-x', user('50', [role], OWN_BRANCH_ID)),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      const body = (error as ForbiddenException).getResponse();
      expect(body).toEqual({
        statusCode: 403,
        message: 'Bu buyurtma sizning filialingizda emas',
        data: { reason: 'order_not_in_your_branch' },
      });
      expect(JSON.stringify(body)).not.toMatch(/Mijoz|Urgut|150000|\+998/);
    },
  );

  it('HQ->filial pochtasi jo`natilgan (manzil — so`rovchi filiali) -> ko`rinadi', async () => {
    // dispatchPostToBranch branch_id va holder_branch_id ni manzilga o'tkazadi.
    const { controller } = setup({
      order: qr(fullOrder({ status: 'on the road', post_id: '12' })),
    });
    await expect(
      controller.findByQrCode('ORD-x', user('50', ['manager'], OWN_BRANCH_ID)),
    ).resolves.toMatchObject({ data: { id: '77' } });
  });

  it('SENT paket bilan filialga kelayotgan buyurtma -> ko`rinadi', async () => {
    const { controller, order } = setup({
      order: {
        ...qr(
          fullOrder({
            branch_id: FOREIGN_BRANCH_ID,
            holder_branch_id: FOREIGN_BRANCH_ID,
            current_batch_id: '30',
          }),
        ),
        'order.transfer_batch.find_by_id': {
          statusCode: 200,
          data: {
            id: '30',
            status: 'SENT',
            destination_branch_id: OWN_BRANCH_ID,
          },
        },
      },
    });
    await expect(
      controller.findByQrCode('ORD-x', user('50', ['manager'], OWN_BRANCH_ID)),
    ).resolves.toMatchObject({ data: { id: '77' } });
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.find_by_id' },
      { id: '30' },
    );
  });

  it('KURYER: o`zidagi buyurtma (begona filialda bo`lsa ham) -> ko`rinadi', async () => {
    const { controller, branch } = setup({
      order: qr(
        fullOrder({
          branch_id: FOREIGN_BRANCH_ID,
          holder_branch_id: null,
          holder_type: 'COURIER',
          holder_courier_id: '70',
          courier_id: '70',
        }),
      ),
    });
    await expect(
      controller.findByQrCode('ORD-x', user('70', ['courier'])),
    ).resolves.toMatchObject({ data: { id: '77' } });
    // O'zidagi buyurtma — filial so'ralmaydi.
    expect(cmds(branch)).not.toContain('branch.user.find_by_user');
  });

  it('KURYER: boshqa filial buyurtmasi -> 403 order_not_in_your_branch', async () => {
    const { controller } = setup({
      order: qr(
        fullOrder({
          branch_id: FOREIGN_BRANCH_ID,
          holder_branch_id: FOREIGN_BRANCH_ID,
          courier_id: '71',
        }),
      ),
      branch: {
        'branch.user.find_by_user': {
          statusCode: 200,
          data: { branch_id: OWN_BRANCH_ID, role: 'COURIER' },
        },
      },
    });
    const error = await rejection(
      controller.findByQrCode('ORD-x', user('70', ['courier'])),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      data: { reason: 'order_not_in_your_branch' },
    });
  });

  it('KURYER: hech qaysi filialga biriktirilmagan -> 403 branch_not_assigned, ma`lumotsiz', async () => {
    const { controller } = setup({
      order: qr(fullOrder({ courier_id: '71' })),
      branch: {
        'branch.user.find_by_user': { statusCode: 200, data: null },
      },
    });
    const error = await rejection(
      controller.findByQrCode('ORD-x', user('70', ['courier'])),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    const body = (error as ForbiddenException).getResponse();
    expect(body).toEqual({
      statusCode: 403,
      message:
        'Siz hech qaysi filialga biriktirilmagansiz — administratorga murojaat qiling',
      data: { reason: 'branch_not_assigned' },
    });
    expect(JSON.stringify(body)).not.toMatch(/Mijoz|Urgut|150000|\+998/);
  });

  it('KURYER: filialini aniqlab bo`lmadi -> 503 (fail-closed)', async () => {
    const { controller } = setup({
      order: qr(fullOrder()),
      branch: { 'branch.user.find_by_user': new Error('branch down') },
    });
    await expect(
      controller.findByQrCode('ORD-x', user('70', ['courier'])),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    ['HQ menejeri', ['manager']],
    ['HQ registratori', ['registrator']],
    ['HQ kuryeri', ['courier']],
  ])('%s: istalgan filial buyurtmasi -> cheklanmaydi', async (_l, roles) => {
    const { controller } = setup({
      order: qr(
        fullOrder({
          branch_id: FOREIGN_BRANCH_ID,
          holder_branch_id: FOREIGN_BRANCH_ID,
        }),
      ),
      branch: {
        'branch.user.find_by_user': {
          statusCode: 200,
          data: { branch_id: HQ_BRANCH_ID, role: 'COURIER' },
        },
      },
    });
    await expect(
      controller.findByQrCode('ORD-x', user('60', roles, HQ_BRANCH_ID)),
    ).resolves.toMatchObject({
      data: { id: '77', address: expect.any(String) },
    });
  });

  it.each([['superadmin'], ['admin']])(
    '%s: cheklanmaydi, filial so`ralmaydi',
    async (role) => {
      const { controller, branch } = setup({
        order: qr(fullOrder({ branch_id: FOREIGN_BRANCH_ID })),
      });
      await expect(
        controller.findByQrCode('ORD-x', user('1', [role])),
      ).resolves.toMatchObject({ data: { id: '77' } });
      expect(branch.send).not.toHaveBeenCalled();
    },
  );

  it('MARKET qoidasi o`zgarmagan: o`ziniki -> OK, begona -> 403 (eski xabar)', async () => {
    const own = setup({
      order: qr(fullOrder({ branch_id: FOREIGN_BRANCH_ID })),
    });
    await expect(
      own.controller.findByQrCode('ORD-x', user('201', ['market'])),
    ).resolves.toMatchObject({ data: { id: '77' } });
    expect(own.branch.send).not.toHaveBeenCalled();

    const foreign = setup({ order: qr(fullOrder()) });
    const error = await rejection(
      foreign.controller.findByQrCode('ORD-x', user('202', ['market'])),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      "Bu buyurtmani ko'rishga ruxsat yo'q",
    );
  });
});

describe('anKpzwxk — GET /orders/qr-code/:token?view=light begona filial', () => {
  it('cheklangan so`rovchi: doira AVVAL to`liq qatordan, rad etilsa yengil javob olinmaydi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_qr': {
          statusCode: 200,
          data: fullOrder({
            branch_id: FOREIGN_BRANCH_ID,
            holder_branch_id: FOREIGN_BRANCH_ID,
          }),
        },
        'order.find_by_qr_light': LIGHT,
      },
    });
    const error = await rejection(
      controller.findByQrCode(
        'ORD-x',
        user('50', ['manager'], OWN_BRANCH_ID),
        'light',
      ),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      data: { reason: 'order_not_in_your_branch' },
    });
    expect(cmds(order)).toEqual(['order.find_by_qr']);
  });

  it('cheklangan so`rovchi: o`z filiali -> yengil javob', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_qr': { statusCode: 200, data: fullOrder() },
        'order.find_by_qr_light': LIGHT,
      },
    });
    await expect(
      controller.findByQrCode(
        'ORD-x',
        user('50', ['manager'], OWN_BRANCH_ID),
        'light',
      ),
    ).resolves.toEqual(LIGHT);
    expect(cmds(order)).toEqual(['order.find_by_qr', 'order.find_by_qr_light']);
  });

  it('HQ xodimi: qo`shimcha so`rov yo`q (skaner tezligi)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_by_qr_light': LIGHT },
    });
    await expect(
      controller.findByQrCode(
        'ORD-x',
        user('60', ['registrator'], HQ_BRANCH_ID),
        'light',
      ),
    ).resolves.toEqual(LIGHT);
    expect(cmds(order)).toEqual(['order.find_by_qr_light']);
  });

  it('MARKET: o`zgarmagan — qo`shimcha so`rov yo`q', async () => {
    const { controller, order } = setup({
      order: { 'order.find_by_qr_light': LIGHT },
    });
    await expect(
      controller.findByQrCode('ORD-x', user('201', ['market']), 'light'),
    ).resolves.toEqual(LIGHT);
    expect(cmds(order)).toEqual(['order.find_by_qr_light']);
  });
});

describe('anKpzwxk — HTTP konverti (haqiqiy filtrlar)', () => {
  let app: INestApplication;
  const orderSend = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: makeClient() },
        { provide: 'LOGISTICS', useValue: makeClient() },
        {
          provide: 'BRANCH',
          useValue: makeClient({
            'branch.find_hq': { statusCode: 200, data: { id: HQ_BRANCH_ID } },
          }),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '50',
            roles: ['manager'],
            branch_id: OWN_BRANCH_ID,
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      // Boshqa yo'llardagi per-user throttle guard — bu test uni sinamaydi.
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('begona filial -> 403, tanada faqat xabar va data.reason (buyurtma yo`q)', async () => {
    orderSend.mockImplementation(() =>
      of({
        statusCode: 200,
        data: fullOrder({
          branch_id: FOREIGN_BRANCH_ID,
          holder_branch_id: FOREIGN_BRANCH_ID,
        }),
      }),
    );

    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    ).get('/orders/qr-code/ORD-x');

    expect(res.status).toBe(403);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => key !== 'trace_id')).toEqual([
      'statusCode',
      'message',
      'data',
    ]);
    expect(body).toMatchObject({
      statusCode: 403,
      message: 'Bu buyurtma sizning filialingizda emas',
      data: { reason: 'order_not_in_your_branch' },
    });
    expect(body.data).toEqual({ reason: 'order_not_in_your_branch' });
  });
});
