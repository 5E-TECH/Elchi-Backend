import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RpcException } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import { publicErrorFields } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AiConfirmRequestDto } from './dto/ai-order.swagger.dto';
import {
  CreateExternalOrderRequestDto,
  CreateOrderRequestDto,
  UpdateOrderByIdRequestDto,
  UpdateOrderRequestDto,
} from './dto/order.swagger.dto';
import { SetOrderSpecialCategoriesRequestDto } from './order-create/order-special-categories';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * T8 (0OUcHZ7R) — gateway: maxsus belgilar.
 *  • yaratish DTO'lari (POST /orders, /orders/external, ai-confirm) ixtiyoriy
 *    `special_categories` ni qabul qiladi; noma'lum / takror kod — 400
 *    «Noma'lum maxsus belgi: <kod>»;
 *  • PATCH DTO'lari maydonni QABUL QILMAYDI (forbidNonWhitelisted → 400);
 *  • ai-confirm — belgi faqat o'z buyurtmasiga;
 *  • PUT /orders/:id/special-categories — rollar POST /orders bilan AYNI,
 *    doira (market / operator / filial) shu yerda, `order.special_categories.set`.
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

const errorsOf = async (cls: new () => object, body: unknown) =>
  validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const messagesOf = async (cls: new () => object, body: unknown) =>
  (await errorsOf(cls, body)).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

const CREATE_DTO = {
  customer: { name: 'Ali', phone_number: '+998901112233', district_id: '700' },
  total_price: 120000,
  district_id: '700',
  region_id: '7',
  items: [{ product_id: '142', quantity: 2 }],
};

describe('T8 DTO — special_categories', () => {
  it.each([
    ['POST /orders', CreateOrderRequestDto],
    ['POST /orders/external', CreateExternalOrderRequestDto],
  ])('%s: ixtiyoriy, ma`lum kodlar o`tadi', async (_n, cls) => {
    expect(await errorsOf(cls, CREATE_DTO)).toHaveLength(0);
    expect(
      await errorsOf(cls, {
        ...CREATE_DTO,
        special_categories: ['liquid', 'fragile'],
      }),
    ).toHaveLength(0);
    expect(
      await errorsOf(cls, { ...CREATE_DTO, special_categories: [] }),
    ).toHaveLength(0);
  });

  it.each([
    [['glass'], "Noma'lum maxsus belgi: glass"],
    [['fragile', 'fragile'], 'Maxsus belgi takrorlangan: fragile'],
    ['fragile', "special_categories massiv bo'lishi kerak"],
  ])('⭐ POST /orders %j → 400 «%s»', async (value, message) => {
    expect(
      await messagesOf(CreateOrderRequestDto, {
        ...CREATE_DTO,
        special_categories: value,
      }),
    ).toEqual([message]);
  });

  it.each([
    ['PATCH /orders/:id', UpdateOrderByIdRequestDto],
    ['order update', UpdateOrderRequestDto],
  ])('⭐ %s maydonni qabul QILMAYDI (400)', async (_n, cls) => {
    const errors = await errorsOf(cls, { special_categories: ['fragile'] });
    expect(errors.map((e) => e.property)).toContain('special_categories');
  });

  it('PUT tanasi: majburiy massiv, [] ruxsat', async () => {
    expect(
      await errorsOf(SetOrderSpecialCategoriesRequestDto, {
        special_categories: [],
      }),
    ).toHaveLength(0);
    expect(
      await errorsOf(SetOrderSpecialCategoriesRequestDto, {}),
    ).not.toHaveLength(0);
    expect(
      await messagesOf(SetOrderSpecialCategoriesRequestDto, {
        special_categories: ['glass'],
      }),
    ).toEqual(["Noma'lum maxsus belgi: glass"]);
  });

  it('ai-confirm: har buyurtmada alohida, noma`lum kod — 400', async () => {
    const order = {
      customer: {
        name: 'Ali',
        phone_number: '+998901112233',
        district_id: '700',
      },
      district_id: '700',
      items: [{ product_id: '142', quantity: 1 }],
      total_price: 100000,
      where_deliver: 'center',
    };
    expect(
      await errorsOf(AiConfirmRequestDto, {
        orders: [order, { ...order, special_categories: ['religious_book'] }],
      }),
    ).toHaveLength(0);
    expect(
      await errorsOf(AiConfirmRequestDto, {
        orders: [{ ...order, special_categories: ['glass'] }],
      }),
    ).not.toHaveLength(0);
  });
});

describe('T8 yaratish — order.create ga uzatiladi', () => {
  const orderHandlers = {
    'order.create': { statusCode: 201, data: { id: '900', market_id: '121' } },
  };
  const identityHandlers = {
    'identity.customer.create': { data: { id: '801' } },
    'identity.market.find_by_id': {
      data: { id: '121', status: 'active', add_order: true },
    },
  };

  it('POST /orders: special_categories order-service`ga boradi', async () => {
    const { controller, order } = setup({
      order: orderHandlers,
      identity: identityHandlers,
    });
    await controller.create(
      { ...CREATE_DTO, special_categories: ['liquid', 'fragile'] },
      user('121', ['market']),
    );
    expect(sentTo(order, 'order.create')[0].dto.special_categories).toEqual([
      'liquid',
      'fragile',
    ]);
  });

  it('⭐ ai-confirm: religious_book faqat 2-buyurtmada → faqat o`shanga', async () => {
    const { controller, order } = setup({
      order: orderHandlers,
      identity: identityHandlers,
    });
    const createAiOrder = (
      controller as unknown as {
        createAiOrder: (...args: unknown[]) => Promise<unknown>;
      }
    ).createAiOrder.bind(controller);
    const base = {
      customer: {
        name: 'Ali',
        phone_number: '+998901112233',
        district_id: '700',
      },
      district_id: '700',
      items: [{ product_id: '142', quantity: 1 }],
      total_price: 100000,
      where_deliver: 'center',
    };
    const item = (index: number, extra: Record<string, unknown> = {}) => ({
      index,
      order: { ...base, ...extra },
      signature: `sig-${index}`,
      districtId: '700',
      regionId: '7',
      stableRequestId: null,
      aiAudit: null,
    });
    const ctx = {
      marketId: '121',
      marketProfile: null,
      operatorName: null,
      includeMarketId: false,
      branchAssignment: null,
    };
    const req = { user: { sub: '121', roles: ['market'] } };
    await createAiOrder(item(0), req, ctx);
    await createAiOrder(
      item(1, { special_categories: ['religious_book'] }),
      req,
      ctx,
    );
    await createAiOrder(item(2), req, ctx);
    expect(
      sentTo(order, 'order.create').map((p) => p.dto.special_categories),
    ).toEqual([undefined, ['religious_book'], undefined]);
  });
});

describe('T8 PUT /orders/:id/special-categories', () => {
  const ROUTE_ROLES = [
    'superadmin',
    'admin',
    'registrator',
    'market',
    'manager',
    'branch',
    'market_operator',
  ];
  const ok = {
    statusCode: 200,
    message: 'success',
    data: { id: '10', special_categories: ['fragile'], changed: true },
  };

  it('rollar POST /orders bilan AYNI; kuryer / investor — RolesGuard 403', () => {
    const handlerOf = (name: keyof OrderGatewayController): object =>
      Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
        ?.value as object;
    const rolesOf = (name: keyof OrderGatewayController) =>
      Reflect.getMetadata(ROLES_KEY, handlerOf(name)) as string[];
    const roles = rolesOf('setSpecialCategories');
    const createRoles = rolesOf('create');
    expect([...roles].sort()).toEqual([...ROUTE_ROLES].sort());
    expect([...roles].sort()).toEqual([...createRoles].sort());
    expect(roles).not.toContain('courier');
    expect(roles).not.toContain('investor');
    expect(
      Reflect.getMetadata(GUARDS_METADATA, handlerOf('setSpecialCategories')),
    ).toContain(RolesGuard);
  });

  it('⭐ market: o`z doirasi market_id bilan uzatiladi (egalik order-service`da qulf ostida)', async () => {
    const { controller, order } = setup({
      order: { 'order.special_categories.set': ok },
    });
    const res = await controller.setSpecialCategories(
      '10',
      { special_categories: ['fragile'] },
      user('201', ['market']),
    );
    expect(res).toEqual(ok);
    expect(sentTo(order, 'order.special_categories.set')).toEqual([
      {
        id: '10',
        special_categories: ['fragile'],
        requester: { id: '201', roles: ['market'], market_id: '201' },
      },
    ]);
  });

  it('market operatori: biriktirilgan market (identity) uzatiladi', async () => {
    const { controller, order } = setup({
      order: { 'order.special_categories.set': ok },
      identity: {
        'identity.user.find_by_id': { data: { market_id: '555' } },
      },
    });
    await controller.setSpecialCategories(
      '10',
      { special_categories: ['fragile'] },
      user('601', ['market_operator']),
    );
    expect(sentTo(order, 'order.special_categories.set')[0].requester).toEqual({
      id: '601',
      roles: ['market_operator'],
      market_id: '555',
    });
  });

  it('marketga biriktirilmagan operator → 403, order-service`ga bormaydi', async () => {
    const { controller, order } = setup({
      identity: { 'identity.user.find_by_id': { data: { market_id: null } } },
    });
    await expect(
      controller.setSpecialCategories(
        '10',
        { special_categories: ['fragile'] },
        user('601', ['market_operator']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.special_categories.set')).toHaveLength(0);
  });

  it.each([['registrator'], ['manager'], ['branch']])(
    '%s: boshqa filial buyurtmasi → 403; o`z filiali → uzatiladi (market_id siz)',
    async (role) => {
      const handlers = {
        'order.find_by_id': {
          id: '10',
          branch_id: '21',
          holder_branch_id: '21',
          home_branch_id: '21',
        },
        'order.special_categories.set': ok,
      };
      const other = setup({ order: handlers });
      await expect(
        other.controller.setSpecialCategories(
          '10',
          { special_categories: ['fragile'] },
          user('300', [role], '22'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sentTo(other.order, 'order.special_categories.set')).toHaveLength(
        0,
      );

      const own = setup({ order: handlers });
      await own.controller.setSpecialCategories(
        '10',
        { special_categories: ['fragile'] },
        user('300', [role], '21'),
      );
      expect(
        sentTo(own.order, 'order.special_categories.set')[0].requester,
      ).toEqual({ id: '300', roles: [role] });
    },
  );

  it('admin: doira tekshiruvisiz uzatiladi', async () => {
    const { controller, order } = setup({
      order: { 'order.special_categories.set': ok },
    });
    await controller.setSpecialCategories(
      '10',
      { special_categories: [] },
      user('2', ['admin']),
    );
    expect(sentTo(order, 'order.find_by_id')).toHaveLength(0);
    expect(sentTo(order, 'order.special_categories.set')[0]).toEqual({
      id: '10',
      special_categories: [],
      requester: { id: '2', roles: ['admin'] },
    });
  });

  it('409 SPECIAL_CATEGORIES_LOCKED — kod javobga chiqadi (PUBLIC_ERROR_CODES)', async () => {
    const locked = new RpcException({
      statusCode: 409,
      code: 'SPECIAL_CATEGORIES_LOCKED',
      message: "Bu holatda maxsus belgini o'zgartirib bo'lmaydi",
    });
    const { controller } = setup({
      order: { 'order.special_categories.set': locked },
    });
    const error = await controller
      .setSpecialCategories(
        '10',
        { special_categories: ['fragile'] },
        user('2', ['admin']),
      )
      .catch((e: unknown) => e);
    expect(error).toBe(locked);
    expect(publicErrorFields(locked.getError())).toEqual({
      code: 'SPECIAL_CATEGORIES_LOCKED',
    });
  });
});
