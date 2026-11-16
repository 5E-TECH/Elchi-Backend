import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RpcException } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import { publicErrorFields } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AssignOrderOperatorRequestDto } from './order-create/order-assign-operator.dto';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 2026-11-16 (Dilshod): «operator tanlanmasa shu buyurtmaga operator biriktirib qo'yish imkoni bo'lishi kerak» —
 * gateway `PUT /orders/:id/operator`:
 *  • rollar — yaratish formasida «Operator» tanlovini ko'radiganlar (market operatori va kuryer — yo'q);
 *  • doira: market — o'z buyurtmasi; registrator / menejer / filial — o'z filiali; SA/admin — istalgan;
 *  • operator — BUYURTMA marketining faol operatori (`identity.market_operator.selectable`), aks holda 400;
 *  • order-service'ga tekshirilgan `market_id`, operator ismi va doira uzatiladi; 409 kodlari javobga chiqadi.
 */
type Handlers = Record<string, unknown>;

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

function setup(opts: { order?: Handlers; identity?: Handlers } = {}) {
  const order = makeClient(opts.order);
  const identity = makeClient(opts.identity);
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: '1' } },
  });
  const controller = new OrderGatewayController(
    order as never,
    identity as never,
    makeClient() as never,
    branch as never,
  );
  return { controller, order, identity };
}

const sentTo = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][])
    .filter((args) => (args[0] as { cmd?: string })?.cmd === cmd)
    .map((args) => args[1] as Record<string, any>);

const user = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as never;

const ORDER_ROW = {
  id: '10',
  market_id: '201',
  branch_id: '21',
  holder_branch_id: '21',
  home_branch_id: '21',
};
const SELECTABLE = {
  statusCode: 200,
  data: { items: [{ id: '412', name: 'Aziza Karimova' }] },
};
const OK = {
  statusCode: 200,
  message: 'success',
  data: {
    id: '10',
    operator_id: '412',
    operator: 'Aziza Karimova',
    earning_recorded: false,
  },
};

const handlers = (extra: Handlers = {}): Handlers => ({
  'order.find_by_id': ORDER_ROW,
  'order.operator.assign': OK,
  ...extra,
});

describe('2026-11-16 PUT /orders/:id/operator — DTO va rollar', () => {
  it('tana: operator_id majburiy raqamli satr', async () => {
    const errors = async (body: unknown) =>
      validate(plainToInstance(AssignOrderOperatorRequestDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(await errors({ operator_id: '412' })).toHaveLength(0);
    expect(await errors({})).not.toHaveLength(0);
    expect(await errors({ operator_id: 'abc' })).not.toHaveLength(0);
    expect(
      await errors({ operator_id: '412', market_id: '9' }),
    ).not.toHaveLength(0);
  });

  it('rollar: SA, admin, registrator, menejer, filial, market; market operatori va kuryer — RolesGuard 403', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'assignOperator',
    )?.value as object;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect([...roles].sort()).toEqual(
      [
        'superadmin',
        'admin',
        'registrator',
        'manager',
        'branch',
        'market',
      ].sort(),
    );
    expect(roles).not.toContain('market_operator');
    expect(roles).not.toContain('courier');
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});

describe('2026-11-16 PUT /orders/:id/operator — oqim', () => {
  it('⭐ admin: buyurtma marketi bo`yicha tekshiradi, ism + market_id order-service`ga', async () => {
    const { controller, order, identity } = setup({
      order: handlers(),
      identity: { 'identity.market_operator.selectable': SELECTABLE },
    });

    const res = await controller.assignOperator(
      '10',
      { operator_id: '412' },
      user('2', ['admin']),
    );

    expect(res).toEqual(OK);
    expect(sentTo(identity, 'identity.market_operator.selectable')).toEqual([
      { market_id: '201', operator_id: '412' },
    ]);
    expect(sentTo(order, 'order.operator.assign')).toEqual([
      {
        id: '10',
        operator_id: '412',
        operator_name: 'Aziza Karimova',
        market_id: '201',
        requester: { id: '2', roles: ['admin'] },
      },
    ]);
  });

  it('⭐ market: o`z buyurtmasi — market_id doirasi bilan uzatiladi', async () => {
    const { controller, order } = setup({
      order: handlers(),
      identity: { 'identity.market_operator.selectable': SELECTABLE },
    });
    await controller.assignOperator(
      '10',
      { operator_id: '412' },
      user('201', ['market']),
    );
    expect(sentTo(order, 'order.operator.assign')[0].requester).toEqual({
      id: '201',
      roles: ['market'],
      market_id: '201',
    });
  });

  it('market: begona buyurtma — 403, operator tekshirilmaydi va order-service`ga bormaydi', async () => {
    const { controller, order, identity } = setup({
      order: handlers(),
      identity: { 'identity.market_operator.selectable': SELECTABLE },
    });
    await expect(
      controller.assignOperator(
        '10',
        { operator_id: '412' },
        user('999', ['market']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      sentTo(identity, 'identity.market_operator.selectable'),
    ).toHaveLength(0);
    expect(sentTo(order, 'order.operator.assign')).toHaveLength(0);
  });

  it('operator buyurtma marketida faol emas — 400 «Tanlangan operator …», order-service`ga bormaydi', async () => {
    const { controller, order } = setup({
      order: handlers(),
      identity: {
        'identity.market_operator.selectable': {
          statusCode: 200,
          data: { items: [] },
        },
      },
    });
    const error = await controller
      .assignOperator('10', { operator_id: '412' }, user('2', ['admin']))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'Tanlangan operator bu marketga tegishli emas yoki faol emas',
    );
    expect(sentTo(order, 'order.operator.assign')).toHaveLength(0);
  });

  it.each([['registrator'], ['manager'], ['branch']])(
    '%s: boshqa filial buyurtmasi → 403; o`z filiali → uzatiladi (market_id doirasisiz)',
    async (role) => {
      const other = setup({
        order: handlers(),
        identity: { 'identity.market_operator.selectable': SELECTABLE },
      });
      await expect(
        other.controller.assignOperator(
          '10',
          { operator_id: '412' },
          user('300', [role], '22'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sentTo(other.order, 'order.operator.assign')).toHaveLength(0);

      const own = setup({
        order: handlers(),
        identity: { 'identity.market_operator.selectable': SELECTABLE },
      });
      await own.controller.assignOperator(
        '10',
        { operator_id: '412' },
        user('300', [role], '21'),
      );
      expect(sentTo(own.order, 'order.operator.assign')[0].requester).toEqual({
        id: '300',
        roles: [role],
      });
    },
  );

  it('buyurtma yo`q — 404', async () => {
    const { controller, order } = setup({
      order: { 'order.find_by_id': null },
    });
    await expect(
      controller.assignOperator(
        '10',
        { operator_id: '412' },
        user('2', ['admin']),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sentTo(order, 'order.operator.assign')).toHaveLength(0);
  });

  it.each([
    'ORDER_OPERATOR_ALREADY_ASSIGNED',
    'ORDER_OPERATOR_EXTERNAL',
    'ORDER_OPERATOR_MARKET_CHANGED',
  ])('409 %s — kod javobga chiqadi (PUBLIC_ERROR_CODES)', async (code) => {
    const conflict = new RpcException({ statusCode: 409, code, message: 'x' });
    const { controller } = setup({
      order: handlers({ 'order.operator.assign': conflict }),
      identity: { 'identity.market_operator.selectable': SELECTABLE },
    });
    const error = await controller
      .assignOperator('10', { operator_id: '412' }, user('2', ['admin']))
      .catch((e: unknown) => e);
    expect(error).toBe(conflict);
    expect(publicErrorFields(conflict.getError())).toEqual({ code });
  });
});
