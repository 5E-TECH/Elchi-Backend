import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { AiConfirmRequestDto } from './dto/ai-order.swagger.dto';
import { CreateOrderRequestDto } from './dto/order.swagger.dto';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 6kHnNH9j — gateway: buyurtma manbasi (`fulfillment`, kontrakt B):
 *   - `POST /orders` va ai-confirm tanasida ixtiyoriy `auto | hq` (sukut
 *     `auto`), boshqa qiymat — 400 (DTO);
 *   - `order.create` ga DOIM `fulfillment` boradi: qo'lda/AI — `auto`
 *     yoki tanlangani, bot yo'li — `hq` (kontraktda yo'q);
 *   - `GET /orders?fulfillment_source=` — HQ | WAREHOUSE (katta-kichik harf
 *     farqsiz), noto'g'ri — 400, order-service'ga yetmaydi.
 */
const MARKET_ID = '121';

const dto = {
  customer: { name: 'Ali', phone_number: '+998901112233', district_id: '700' },
  total_price: 120000,
  district_id: '700',
  region_id: '7',
  items: [{ product_id: '142', quantity: 2 }],
};

function makeController() {
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.create'
        ? of({
            statusCode: 201,
            data: {
              id: '900',
              market_id: MARKET_ID,
              fulfillment_source: 'WAREHOUSE',
            },
          })
        : of({ data: [], total: 0 }),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload?: { id?: string }) => {
      if (pattern.cmd === 'identity.customer.create') {
        return of({ data: { id: '801' } });
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({
          data: { id: payload?.id, status: 'active', add_order: true },
        });
      }
      return of({ data: { id: payload?.id, name: 'Operator' } });
    }),
  };
  const controller = new OrderGatewayController(
    orderClient as never,
    identityClient as never,
    { send: jest.fn(() => of({})) } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
  );
  return { controller, orderClient };
}

const marketReq = () =>
  ({ user: { sub: MARKET_ID, username: 'm', roles: ['market'] } }) as never;

const sentCreates = (orderClient: { send: jest.Mock }) =>
  (orderClient.send.mock.calls as unknown[][])
    .filter((args) => (args[0] as { cmd?: string })?.cmd === 'order.create')
    .map((args) => args[1] as { dto: Record<string, unknown> });

const errorsOf = async (cls: new () => object, body: unknown) =>
  validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('6kHnNH9j — buyurtma manbasi (gateway)', () => {
  describe('DTO', () => {
    it('⭐ POST /orders: fulfillment — auto | hq (katta harf ham), boshqasi — 400; fulfillment_source/warehouse_id — taqiqlangan', async () => {
      for (const value of [undefined, 'auto', 'hq', 'HQ', ' Auto ']) {
        expect(
          await errorsOf(CreateOrderRequestDto, { ...dto, fulfillment: value }),
        ).toHaveLength(0);
      }
      for (const value of ['warehouse', 'WAREHOUSE', 1, true]) {
        expect(
          await errorsOf(CreateOrderRequestDto, { ...dto, fulfillment: value }),
        ).not.toHaveLength(0);
      }
      for (const field of ['fulfillment_source', 'warehouse_id']) {
        expect(
          await errorsOf(CreateOrderRequestDto, {
            ...dto,
            [field]: 'WAREHOUSE',
          }),
        ).not.toHaveLength(0);
      }
    });

    it('ai-confirm: so`rov darajasida va har buyurtmada fulfillment', async () => {
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
          fulfillment: 'hq',
          orders: [{ ...order, fulfillment: 'auto' }],
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(AiConfirmRequestDto, {
          fulfillment: 'ombor',
          orders: [order],
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(AiConfirmRequestDto, {
          orders: [{ ...order, fulfillment: 'ombor' }],
        }),
      ).not.toHaveLength(0);
    });
  });

  describe('order.create payload', () => {
    it('⭐ sukut `auto`; tanlangan `hq` — o`zgarishsiz', async () => {
      const { controller, orderClient } = makeController();
      await controller.create(dto as never, marketReq());
      await controller.create(
        { ...dto, fulfillment: 'hq' } as never,
        marketReq(),
      );
      expect(sentCreates(orderClient).map((p) => p.dto.fulfillment)).toEqual([
        'auto',
        'hq',
      ]);
    });

    it('bot yo`li (createdVia: bot) — doim `hq`', async () => {
      const { controller, orderClient } = makeController();
      await (
        controller as unknown as {
          createOrderInternal: (...args: unknown[]) => Promise<unknown>;
        }
      ).createOrderInternal(
        { ...dto, fulfillment: 'auto' },
        { user: { sub: MARKET_ID, roles: ['market'] } },
        { createdVia: 'bot' },
      );
      expect(sentCreates(orderClient)[0].dto.fulfillment).toBe('hq');
    });

    it('⭐ ai-confirm: buyurtmaniki → so`rovniki → `auto`', async () => {
      const { controller, orderClient } = makeController();
      const createAiOrder = (
        controller as unknown as {
          createAiOrder: (...args: unknown[]) => Promise<unknown>;
        }
      ).createAiOrder.bind(controller);
      const item = (fulfillment?: string) => ({
        index: 0,
        order: {
          customer: {
            name: 'Ali',
            phone_number: '+998901112233',
            district_id: '700',
          },
          district_id: '700',
          items: [{ product_id: '142', quantity: 1 }],
          total_price: 100000,
          where_deliver: 'center',
          ...(fulfillment ? { fulfillment } : {}),
        },
        signature: 'sig',
        districtId: '700',
        regionId: '7',
        stableRequestId: null,
        aiAudit: null,
      });
      const ctx = (fulfillment?: string) => ({
        marketId: MARKET_ID,
        marketProfile: null,
        operatorName: null,
        includeMarketId: false,
        branchAssignment: null,
        fulfillment,
      });
      const req = { user: { sub: MARKET_ID, roles: ['market'] } };
      await createAiOrder(item('auto'), req, ctx('hq'));
      await createAiOrder(item(), req, ctx('hq'));
      await createAiOrder(item(), req, ctx());
      expect(sentCreates(orderClient).map((p) => p.dto.fulfillment)).toEqual([
        'auto',
        'hq',
        'auto',
      ]);
    });
  });

  describe('GET /orders?fulfillment_source=', () => {
    type Resolver = (
      filters: Record<string, unknown>,
      user: unknown,
    ) => Promise<{ kind: string; query?: Record<string, unknown> }>;
    const resolverOf = (controller: OrderGatewayController): Resolver =>
      (
        controller as unknown as { resolveOrderListRequest: Resolver }
      ).resolveOrderListRequest.bind(controller);
    const admin = { sub: '2', roles: ['admin'] };

    it('⭐ WAREHOUSE / hq — katta harfga keltirilib uzatiladi; berilmasa — kalit yo`q', async () => {
      const { controller } = makeController();
      const resolve = resolverOf(controller);
      await expect(
        resolve({ fulfillment_source: 'warehouse' }, admin),
      ).resolves.toMatchObject({
        kind: 'query',
        query: { fulfillment_source: 'WAREHOUSE' },
      });
      await expect(
        resolve({ fulfillment_source: 'hq' }, admin),
      ).resolves.toMatchObject({ query: { fulfillment_source: 'HQ' } });
      const none = await resolve({}, admin);
      expect(none.query).not.toHaveProperty('fulfillment_source');
    });

    it('noto`g`ri qiymat — 400, order-service`ga so`rov yo`q', async () => {
      const { controller, orderClient } = makeController();
      await expect(
        resolverOf(controller)({ fulfillment_source: 'ombor' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      // GET /orders handler: `fulfillment_source` — 22-parametr (oxirgi).
      const args: unknown[] = Array.from({ length: 21 }, () => undefined);
      args.push('ombor');
      await expect(
        (
          controller.findAll as unknown as (...a: unknown[]) => Promise<unknown>
        ).apply(controller, args),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderClient.send).not.toHaveBeenCalled();
    });
  });
});
