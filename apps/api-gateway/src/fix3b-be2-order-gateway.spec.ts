import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of, throwError } from 'rxjs';
import { gatewayValidationSchema } from '@app/common';
import { authThrottleConfig } from './auth-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { ConnectTelegramByTokenRequestDto } from './dto/notification.swagger.dto';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * fix3b BE-2 — order-gateway:
 *
 *  1. PATCH /orders/:id va /:id/full ALOHIDA `order.update_from_api`
 *     pattern'iga boradi (order-service uni updateFromApi ga ulaydi);
 *     ichki `order.update*` pattern'lari ishlatilmaydi.
 *  2. `order.find_by_id` buyurtma qatorini O'RAMSIZ qaytaradi — doira
 *     tekshiruvi endi uni o'qiydi (ilgari faqat `.data` o'qilib, filial /
 *     market egasi tekshiruvi prod'da jimgina o'tkazib yuborilardi).
 *  3. GET /orders/:id/settlement — MANAGER/REGISTRATOR faqat o'z filiali
 *     doirasidagi buyurtma; SA/ADMIN cheklovsiz.
 *  4. POST /notifications/connect-by-token Swagger misoli — maxfiy token
 *     formati (market id emas).
 *  5. Auth throttle: gateway kodidagi sukutlar Joi sukutlari bilan AYNI.
 */
type Handlers = Record<string, unknown>;

/** @nestjs/swagger `DECORATORS.API_MODEL_PROPERTIES` (paket chuqur importga ruxsat bermaydi). */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      if (handler instanceof Error) {
        return throwError(() => handler);
      }
      if (
        handler &&
        typeof handler === 'object' &&
        'rpcError' in (handler as Record<string, unknown>)
      ) {
        return throwError(() => (handler as { rpcError: unknown }).rpcError);
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
    'branch.find_hq': { statusCode: 200, data: { id: '1' } },
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

const cmdsOf = (client: { send: jest.Mock }) =>
  (client.send.mock.calls as unknown[][]).map(
    (args) => (args[0] as { cmd: string }).cmd,
  );

const sentTo = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
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

/** order-service `findById` javobi — O'RAMSIZ buyurtma qatori. */
const rawOrder = (overrides: Record<string, unknown> = {}) => ({
  id: '10',
  market_id: '201',
  branch_id: '21',
  holder_branch_id: '21',
  home_branch_id: '1',
  status: 'new',
  ...overrides,
});

const settlementRow = {
  statusCode: 200,
  data: { order_id: '10', courier_amount: 25000, status: 'PENDING' },
};

describe('fix3b BE-2 — PATCH /orders/:id → order.update_from_api', () => {
  it.each([['update'], ['updateFull']] as const)(
    '%s: superadmin → order.update_from_api {id, dto, requester}',
    async (method) => {
      const { controller, order } = setup({
        order: { 'order.update_from_api': { statusCode: 200, data: {} } },
      });

      await controller[method](
        '10',
        { comment: 'tahrir', total_price: 5000 } as any,
        user('1', ['superadmin']),
      );

      expect(cmdsOf(order)).toEqual(['order.update_from_api']);
      expect(sentTo(order, 'order.update_from_api')[0][1]).toEqual({
        id: '10',
        dto: { comment: 'tahrir', total_price: 5000 },
        requester: { id: '1', roles: ['superadmin'] },
      });
    },
  );

  it.each([['update'], ['updateFull']] as const)(
    '%s: ichki order.update / update_full / update_normalized ishlatilmaydi',
    async (method) => {
      const { controller, order } = setup({
        order: {
          'order.find_by_id': rawOrder(),
          'order.update_from_api': { statusCode: 200, data: {} },
        },
      });

      await controller[method](
        '10',
        { comment: 'x' } as any,
        user('300', ['registrator'], '21'),
      );

      const cmds = cmdsOf(order);
      expect(cmds).toContain('order.update_from_api');
      expect(cmds).not.toContain('order.update');
      expect(cmds).not.toContain('order.update_full');
      expect(cmds).not.toContain('order.update_normalized');
    },
  );
});

describe("fix3b BE-2 — doira tekshiruvi O'RAMSIZ order.find_by_id qatorini o'qiydi", () => {
  it('REGISTRATOR boshqa filial buyurtmasi (xom qator) → 403, PATCH yuborilmaydi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_id': rawOrder(),
        'order.update_from_api': { statusCode: 200, data: {} },
      },
    });

    await expect(
      controller.update(
        '10',
        { comment: 'x' } as any,
        user('301', ['registrator'], '22'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.update_from_api')).toHaveLength(0);
  });

  it('REGISTRATOR o‘z filiali (holder_branch_id, xom qator) → uzatiladi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_id': rawOrder({ branch_id: '30' }),
        'order.update_from_api': { statusCode: 200, data: {} },
      },
    });

    await controller.updateFull(
      '10',
      { comment: 'ok' } as any,
      user('300', ['registrator'], '21'),
    );

    expect(sentTo(order, 'order.update_from_api')).toHaveLength(1);
  });

  it('MARKET boshqa market buyurtmasini o‘chira olmaydi (xom qator) → 403', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_id': rawOrder({ market_id: '202' }),
        'order.delete': { statusCode: 200, data: {} },
      },
    });

    await expect(
      controller.remove('10', user('201', ['market'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.delete')).toHaveLength(0);
  });

  it('MARKET o‘z buyurtmasi (xom qator) → order.delete ga uzatiladi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_id': rawOrder({ market_id: '201' }),
        'order.delete': { statusCode: 200, data: {} },
      },
    });

    await controller.remove('10', user('201', ['market']));

    expect(sentTo(order, 'order.delete')).toHaveLength(1);
  });

  it("buyurtma yo'q — order-service 404 o'zgarishsiz qaytadi, keyingi chaqiruv yo'q", async () => {
    const notFound = { statusCode: 404, message: 'Order #10 topilmadi' };
    const { controller, order } = setup({
      order: { 'order.find_by_id': { rpcError: notFound } },
    });

    await expect(
      controller.update(
        '10',
        { comment: 'x' } as any,
        user('300', ['registrator'], '21'),
      ),
    ).rejects.toEqual(notFound);
    expect(cmdsOf(order)).toEqual(['order.find_by_id']);
  });
});

describe('fix3b BE-2 — GET /orders/:id/settlement filial doirasi', () => {
  it('rollar o‘zgarmagan: SA/ADMIN/REGISTRATOR/MANAGER, RolesGuard bilan', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'getOrderSettlement',
    )?.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      'superadmin',
      'admin',
      'registrator',
      'manager',
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it.each([['superadmin'], ['admin']])(
    '%s → buyurtma oldindan o‘qilmaydi, hisob-kitob qaytadi',
    async (role) => {
      const { controller, order } = setup({
        order: { 'order.settlement.find_by_order': settlementRow },
      });

      const res = await controller.getOrderSettlement('10', user('1', [role]));

      expect(res).toEqual(settlementRow);
      expect(cmdsOf(order)).toEqual(['order.settlement.find_by_order']);
      expect(sentTo(order, 'order.settlement.find_by_order')[0][1]).toEqual({
        id: '10',
      });
    },
  );

  it.each([
    ['branch_id', rawOrder({ branch_id: '21', holder_branch_id: null })],
    ['holder_branch_id', rawOrder({ branch_id: '30', holder_branch_id: '21' })],
    [
      'home_branch_id',
      rawOrder({
        branch_id: '30',
        holder_branch_id: null,
        home_branch_id: '21',
      }),
    ],
  ])(
    "MANAGER o'z filiali (%s mos) → hisob-kitob qaytadi",
    async (_label, row) => {
      const { controller, order } = setup({
        order: {
          'order.find_by_id': row,
          'order.settlement.find_by_order': settlementRow,
        },
      });

      const res = await controller.getOrderSettlement(
        '10',
        user('500', ['manager'], '21'),
      );

      expect(res).toEqual(settlementRow);
      expect(cmdsOf(order)).toEqual([
        'order.find_by_id',
        'order.settlement.find_by_order',
      ]);
    },
  );

  it.each([['manager'], ['registrator']])(
    '%s boshqa filial buyurtmasi → 403, hisob-kitob o‘qilmaydi',
    async (role) => {
      const { controller, order } = setup({
        order: {
          'order.find_by_id': rawOrder({
            branch_id: '30',
            holder_branch_id: '30',
            home_branch_id: '1',
          }),
          'order.settlement.find_by_order': settlementRow,
        },
      });

      await expect(
        controller.getOrderSettlement('10', user('500', [role], '21')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sentTo(order, 'order.settlement.find_by_order')).toHaveLength(0);
    },
  );

  it('JWT da filial yo‘q — branch.user.find_by_user dan olinadi (o‘z filiali → ruxsat)', async () => {
    const { controller, order, branch } = setup({
      order: {
        'order.find_by_id': rawOrder(),
        'order.settlement.find_by_order': settlementRow,
      },
      branch: {
        'branch.user.find_by_user': {
          statusCode: 200,
          data: { branch_id: '21', role: 'REGISTRATOR' },
        },
      },
    });

    const res = await controller.getOrderSettlement(
      '10',
      user('300', ['registrator']),
    );

    expect(res).toEqual(settlementRow);
    expect(cmdsOf(branch)).toContain('branch.user.find_by_user');
    expect(sentTo(order, 'order.settlement.find_by_order')).toHaveLength(1);
  });

  it('filialga biriktirilmagan menejer → 403 (fail-closed), hech narsa o‘qilmaydi', async () => {
    const { controller, order } = setup({
      order: { 'order.settlement.find_by_order': settlementRow },
      branch: { 'branch.user.find_by_user': { statusCode: 200, data: null } },
    });

    await expect(
      controller.getOrderSettlement('10', user('500', ['manager'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(order.send).not.toHaveBeenCalled();
  });
});

describe('fix3b BE-2 — connect-by-token Swagger misoli maxfiy token formatida', () => {
  it("`text` misoli group_token-<32 hex>, market id ko'rinishi emas", () => {
    const meta = Reflect.getMetadata(
      API_MODEL_PROPERTIES,
      ConnectTelegramByTokenRequestDto.prototype,
      'text',
    ) as { example?: string; description?: string };

    expect(meta.example).toMatch(/^group_token-[0-9a-f]{32}$/);
    expect(meta.example).not.toMatch(/^group_token-\d{1,13}(-|$)/);
    expect(meta.description).toContain('market_tg_token');
    expect(meta.description).toContain('-cancel');
  });
});

describe('fix3b BE-2 — auth throttle sukutlari: kod = Joi (libs/common/config)', () => {
  it('login 30 / 60 000, refresh 60 / 60 000 — ikkala joyda bir xil', () => {
    const schemaDescription = gatewayValidationSchema.describe() as {
      keys: Record<string, { flags?: { default?: unknown } }>;
    };
    const joiDefault = (key: string) =>
      schemaDescription.keys[key]?.flags?.default;

    const code = authThrottleConfig({});
    expect(code.login.default).toEqual({
      limit: joiDefault('AUTH_THROTTLE_LIMIT'),
      ttl: joiDefault('AUTH_THROTTLE_TTL_MS'),
    });
    expect(code.refresh.default).toEqual({
      limit: joiDefault('AUTH_REFRESH_THROTTLE_LIMIT'),
      ttl: joiDefault('AUTH_REFRESH_THROTTLE_TTL_MS'),
    });
    expect(code.login.default).toEqual({ limit: 30, ttl: 60_000 });
    expect(code.refresh.default).toEqual({ limit: 60, ttl: 60_000 });
  });
});
