import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { WarehouseGatewayController } from './warehouse-gateway.controller';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { CustomerGatewayController } from './customer-gateway.controller';
import { MarketOperatorGatewayController } from './market-operator-gateway.controller';
import { SearchGatewayController } from './search-gateway.controller';
import {
  OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
  OPERATOR_MARKET_FOREIGN_MESSAGE,
} from './auth/market-operator-market';

/**
 * Bitta operator — bir nechta market, 2-bosqich: gateway'ning HAR bir
 * operator doirasi joyi identity `find_by_id.operator_markets` (faol
 * a'zoliklar) bilan ishlaydi.
 *
 * Operator 55: faol — 20 (ombor qoldig'i yoqiq) va 10; taklif — 30;
 * market nofaol qilgan — 40. 16 — umuman begona market.
 *
 * Talablar:
 *  - doiradagi istalgan faol market — ruxsat; taklif / nofaol / begona — rad;
 *  - so'rovdagi `market_id` — faqat doira ichidan tanlov;
 *  - 2+ faol marketda tanlovsiz bitta-marketli amal — 400 (jimgina
 *    «asosiy» marketga tushmaydi);
 *  - faol market yo'q — avvalgi «biriktirilmagan» xatolari.
 * 1 marketli operatorlar uchun avvalgi xatti-harakat mavjud spec'larda
 * (identity `operator_markets` bermagan o'tish davri yo'li) tekshiriladi.
 */
type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      const value =
        typeof handler === 'function'
          ? (handler as (p: unknown) => unknown)(payload)
          : handler;
      return of(value ?? { statusCode: 200, data: null });
    }),
  };
}

const MULTI = [
  {
    market_id: '20',
    status: 'active',
    is_primary: true,
    can_view_warehouse_stock: true,
  },
  {
    market_id: '10',
    status: 'active',
    is_primary: false,
    can_view_warehouse_stock: false,
  },
  {
    market_id: '30',
    status: 'pending',
    is_primary: false,
    can_view_warehouse_stock: true,
  },
  {
    market_id: '40',
    status: 'inactive',
    is_primary: false,
    can_view_warehouse_stock: true,
  },
];

/** identity mock: operator profili (asosiy `market_id` — 20). */
function identityWith(
  operatorMarkets: unknown[] | undefined,
  extra: Handlers = {},
) {
  return makeClient({
    'identity.user.find_by_id': {
      statusCode: 200,
      data: {
        id: '55',
        name: 'Ali Operator',
        role: 'market_operator',
        market_id: '20',
        ...(operatorMarkets ? { operator_markets: operatorMarkets } : {}),
      },
    },
    ...extra,
  });
}

const operator = { sub: '55', username: 'op', roles: ['market_operator'] };
const req = { user: operator } as never;

const expectHttp = async (
  promise: Promise<unknown>,
  type: typeof HttpException,
  message?: string,
) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  if (message) {
    expect((error as HttpException).message).toBe(message);
  }
};

describe('Bitta operator — bir nechta market: gateway doirasi', () => {
  describe('order-gateway', () => {
    const build = (operatorMarkets: unknown[] | undefined = MULTI) => {
      const order = makeClient({
        'order.status_counts': {
          by_status: {},
          total: 0,
          cancelled: null,
          returned_to_market: 0,
          new_incoming: null,
          search_truncated: false,
        },
      });
      const identity = identityWith(operatorMarkets, {
        // assertOrderMarket: market faol emas — yaratish shu yerda to'xtaydi
        // (qaysi market tekshirilganini ko'rish uchun yetarli).
        'identity.market.find_by_id': {
          statusCode: 200,
          data: { id: 'x', role: 'market', status: 'inactive' },
        },
      });
      const controller = new OrderGatewayController(
        order as never,
        identity as never,
        makeClient() as never,
        makeClient() as never,
      );
      const internals = controller as unknown as {
        assertCanViewOrder: (u: unknown, o: unknown) => Promise<void>;
        resolveAiMarket: (u: unknown, m?: string) => Promise<unknown>;
        createOrderInternal: (dto: unknown, r: unknown) => Promise<unknown>;
      };
      return { controller, order, identity, internals };
    };

    const statusCounts = (
      controller: OrderGatewayController,
      marketId?: string,
    ) =>
      controller.statusCounts(
        req,
        marketId,
        ...(Array.from({ length: 15 }, () => undefined) as []),
      );

    const countsQuery = (order: { send: jest.Mock }) =>
      (
        (order.send.mock.calls as unknown[][]).find(
          (args) =>
            (args[0] as { cmd?: string })?.cmd === 'order.status_counts',
        )?.[1] as { query: { market_id?: string } }
      ).query;

    it('ro`yxat doirasi: `market_id` faol marketlardan biri — shu market; begona / taklif / nofaol — 400; tanlovsiz — 400 (asosiyga tushmaydi)', async () => {
      const ok = build();
      await statusCounts(ok.controller, '10');
      expect(countsQuery(ok.order).market_id).toBe('10');

      for (const market of ['16', '30', '40']) {
        const { controller, order } = build();
        await expectHttp(
          statusCounts(controller, market),
          BadRequestException,
          "Market operatori boshqa market ma'lumotini so'rashi mumkin emas",
        );
        expect(order.send).not.toHaveBeenCalled();
      }

      const none = build();
      await expectHttp(
        statusCounts(none.controller),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      expect(none.order.send).not.toHaveBeenCalled();

      const unassigned = build([]);
      await expectHttp(
        statusCounts(unassigned.controller, '20'),
        ForbiddenException,
        'Operator hech qaysi marketga biriktirilmagan',
      );
    });

    it('bitta buyurtma: har qanday faol marketidagi — ko`radi; taklif / nofaol / begona — 403', async () => {
      const { internals } = build();
      await expect(
        internals.assertCanViewOrder(operator, { market_id: '10' }),
      ).resolves.toBeUndefined();
      await expect(
        internals.assertCanViewOrder(operator, { marketId: '20' }),
      ).resolves.toBeUndefined();
      for (const market of ['30', '40', '16', '']) {
        await expectHttp(
          internals.assertCanViewOrder(operator, { market_id: market }),
          ForbiddenException,
        );
      }
    });

    it('AI market: 2+ da `market_id` majburiy va doirada; 1 marketda tanadagi qiymat e`tiborsiz; marketsiz — no_market', async () => {
      const multi = build().internals;
      await expect(multi.resolveAiMarket(operator, '10')).resolves.toEqual({
        marketId: '10',
      });
      await expectHttp(
        multi.resolveAiMarket(operator),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      await expectHttp(
        multi.resolveAiMarket(operator, '30'),
        ForbiddenException,
        OPERATOR_MARKET_FOREIGN_MESSAGE,
      );

      const single = build([MULTI[0]]).internals;
      await expect(single.resolveAiMarket(operator, '16')).resolves.toEqual({
        marketId: '20',
      });
      await expect(
        build([]).internals.resolveAiMarket(operator),
      ).resolves.toEqual({ noMarket: true });
    });

    it('buyurtma yaratish: 2+ da `market_id` majburiy (400) va doirada (403) — mijoz yaratilishidan OLDIN; to`g`risi shu market bilan davom etadi', async () => {
      const dto = (market_id?: string) => ({
        customer: {
          name: 'Mijoz',
          phone_number: '+998901112233',
          district_id: '5',
        },
        district_id: '5',
        items: [{ product_name: 'Choy', quantity: 1 }],
        ...(market_id ? { market_id } : {}),
      });

      const none = build();
      await expectHttp(
        none.internals.createOrderInternal(dto(), req),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      const foreign = build();
      await expectHttp(
        foreign.internals.createOrderInternal(dto('16'), req),
        ForbiddenException,
        OPERATOR_MARKET_FOREIGN_MESSAGE,
      );
      for (const built of [none, foreign]) {
        expect(built.order.send).not.toHaveBeenCalled();
        const cmds = (built.identity.send.mock.calls as unknown[][]).map(
          (args) => (args[0] as { cmd: string }).cmd,
        );
        expect(cmds).toEqual(['identity.user.find_by_id']);
      }

      const ok = build();
      await ok.internals.createOrderInternal(dto('10'), req).catch(() => null);
      expect(ok.identity.send).toHaveBeenCalledWith(
        { cmd: 'identity.market.find_by_id' },
        expect.objectContaining({ id: '10' }),
      );
    });

    it('«Yangi buyurtmalar» (`markets/:marketId/new`): faol marketlar — o`tadi, boshqasi — 403', async () => {
      const { controller } = build();
      await expectHttp(
        controller.findNewOrdersByMarket('40', req),
        ForbiddenException,
        "Market operatori boshqa market ma'lumotini so'rashi mumkin emas",
      );
      const passed: unknown = await controller
        .findNewOrdersByMarket('10', req)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(passed).not.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('warehouse-gateway', () => {
    const build = (operatorMarkets: unknown[] = MULTI) =>
      new WarehouseGatewayController(
        makeClient() as never,
        makeClient() as never,
        identityWith(operatorMarkets) as never,
      );

    it('market tanlovi doiradan; ombor qoldig`i kaliti SHU market a`zoligidan', async () => {
      const controller = build();
      await expect(
        controller.resolveMarketId(operator as never, '20', {
          stockAccess: true,
        }),
      ).resolves.toEqual({ marketId: '20', marketSide: true });
      await expect(
        controller.resolveMarketId(operator as never, '10'),
      ).resolves.toEqual({ marketId: '10', marketSide: true });
      await expectHttp(
        controller.resolveMarketId(operator, '10', {
          stockAccess: true,
        }),
        ForbiddenException,
      );
      // Taklif (30) a'zoligida kalit yoqiq bo'lsa ham — doirada emas.
      await expectHttp(
        controller.resolveMarketId(operator, '30', {
          stockAccess: true,
        }),
        ForbiddenException,
        'Operator faqat biriktirilgan market mahsulotlari bilan ishlay oladi',
      );
      await expectHttp(
        controller.resolveMarketId(operator, undefined),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      await expect(
        build([MULTI[0]]).resolveMarketId(operator as never, undefined, {
          stockAccess: true,
        }),
      ).resolves.toEqual({ marketId: '20', marketSide: true });
    });
  });

  describe('catalog-gateway', () => {
    const build = (operatorMarkets: unknown[] = MULTI) => {
      const controller = new CatalogGatewayController(
        makeClient() as never,
        makeClient() as never,
        identityWith(operatorMarkets) as never,
      );
      return controller as unknown as {
        requireOperatorMarketId: (u: unknown, r?: string) => Promise<string>;
      };
    };

    it('katalog marketi: doiradan tanlov; begona — 403; 2+ da tanlovsiz — 400; marketsiz — 400', async () => {
      await expect(
        build().requireOperatorMarketId(operator, '10'),
      ).resolves.toBe('10');
      await expectHttp(
        build().requireOperatorMarketId(operator, '16'),
        ForbiddenException,
      );
      await expectHttp(
        build().requireOperatorMarketId(operator),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      await expect(
        build([MULTI[1]]).requireOperatorMarketId(operator),
      ).resolves.toBe('10');
      await expectHttp(
        build([]).requireOperatorMarketId(operator),
        BadRequestException,
      );
    });
  });

  describe('customer-gateway (mijoz takliflari)', () => {
    const build = (operatorMarkets: unknown[] = MULTI) =>
      new CustomerGatewayController(
        identityWith(operatorMarkets) as never,
        makeClient() as never,
      );

    it('2+ da `market_id` majburiy va doirada; 1 marketda so`rovdagi qiymat e`tiborsiz (avvalgidek)', async () => {
      await expect(
        build().resolveScope(operator as never, '10'),
      ).resolves.toEqual({ marketId: '10', scoped: true });
      await expectHttp(
        build().resolveScope(operator),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      await expectHttp(
        build().resolveScope(operator, '40'),
        ForbiddenException,
        OPERATOR_MARKET_FOREIGN_MESSAGE,
      );
      await expect(
        build([MULTI[0]]).resolveScope(operator as never, '16'),
      ).resolves.toEqual({ marketId: '20', scoped: true });
    });
  });

  describe('market-operator-gateway («Operator» tanlovi)', () => {
    const build = (operatorMarkets: unknown[] = MULTI) =>
      new MarketOperatorGatewayController(
        identityWith(operatorMarkets) as never,
      ) as unknown as {
        resolveSelectableMarketId: (r: unknown, m?: string) => Promise<string>;
      };

    it('doiradagi market — ruxsat; begona — 400; 2+ da tanlovsiz — 400', async () => {
      await expect(build().resolveSelectableMarketId(req, '10')).resolves.toBe(
        '10',
      );
      await expectHttp(
        build().resolveSelectableMarketId(req, '30'),
        BadRequestException,
        "Market operatori faqat o'z marketi operatorlarini ko'ra oladi (market_id yubormang)",
      );
      await expectHttp(
        build().resolveSelectableMarketId(req),
        BadRequestException,
        OPERATOR_MARKET_AMBIGUOUS_MESSAGE,
      );
      await expect(
        build([MULTI[1]]).resolveSelectableMarketId(req),
      ).resolves.toBe('10');
    });
  });

  describe('search-gateway', () => {
    it('2+ faol marketda (to`plam qidiruvi hali yo`q) buyurtmalar chiqmaydi — fail-closed; 1 marketda — o`sha', async () => {
      const build = (operatorMarkets: unknown[]) =>
        new SearchGatewayController(
          makeClient() as never,
          identityWith(operatorMarkets) as never,
        ) as unknown as {
          resolveOperatorMarketId: (u: unknown) => Promise<string | null>;
        };
      await expect(
        build(MULTI).resolveOperatorMarketId(operator),
      ).resolves.toBe('');
      await expect(
        build([MULTI[1]]).resolveOperatorMarketId(operator),
      ).resolves.toBe('10');
      await expect(build([]).resolveOperatorMarketId(operator)).resolves.toBe(
        '',
      );
    });
  });
});
