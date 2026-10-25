/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
  ORDER_CREATE_NO_DISTRICT_MESSAGE,
  ORDER_CREATE_NO_ITEMS_MESSAGE,
} from '@app/common';
import { Order, Order_source } from '../entities/order.entity';
import { OrderLookupService } from '../lookup/order-lookup.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  isIntegrationOrderCreate,
  resolveOrderCreateContent,
} from './order-create-content';

/**
 * IR2OHIiN — mahsulotsiz va tumansiz buyurtma YARATILMAYDI: yagona yaratish
 * nuqtasi `OrderLifecycleService.create` (+ `createExternalOrder`).
 *
 * Yo'llar (har biri shu nuqtadan o'tadi): POST /orders (market, operator,
 * registrator, menejer/filial «Qabul va yaratish», admin), AI ai-confirm
 * (`auditMetadata`), Telegram bot (`createdVia: bot`), almashtirish
 * (`replaced_order_id`), ombor manbasi (`fulfillment: auto`),
 * POST /orders/external. Hamkor posilkasi (`partner:<id>`) va tashqi saytlar
 * importi (so'rovchisiz `external`) — chiqarilgan (Shodiyor, alohida karta).
 */
type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string };

const MARKET = { id: '37', roles: ['market'] };
const OPERATOR = { id: '77', roles: ['market_operator'] };
const MANAGER = { id: '25', roles: ['manager'], branch_id: '3' };
const REGISTRATOR = { id: '301', roles: ['registrator'], branch_id: '3' };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const PARTNER = { id: 'partner:7', roles: ['superadmin'] };

const ITEMS = [{ product_id: '41', quantity: 2 }];
const BASE = {
  market_id: '37',
  customer_id: '801',
  total_price: 150000,
  district_id: '12',
  region_id: '3',
  items: ITEMS,
};

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) return error.getError() as RpcBody;
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

function makeHarness(opts?: {
  customerDistrictId?: string | null;
  regionForDistrict?: string | null;
}) {
  const mocks = {
    orderCreate: jest.fn((value: Row) => value),
    orderSave: jest.fn((value: Row) =>
      Promise.resolve({ id: '900', product_quantity: 0, ...value }),
    ),
    itemValues: jest.fn(() => ({ execute: jest.fn() })),
    startTransaction: jest.fn(),
    getCustomerDistrictId: jest.fn(() =>
      Promise.resolve(
        opts?.customerDistrictId === undefined ? '12' : opts.customerDistrictId,
      ),
    ),
    resolveRegionIdForDistrict: jest.fn(() =>
      Promise.resolve(
        opts?.regionForDistrict === undefined ? '3' : opts.regionForDistrict,
      ),
    ),
    planCreate: jest.fn(() => Promise.resolve(null)),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: mocks.startTransaction,
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? {
              create: mocks.orderCreate,
              save: mocks.orderSave,
              update: jest.fn(),
            }
          : {
              createQueryBuilder: () => ({
                insert: () => ({ values: mocks.itemValues }),
              }),
            },
      ),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    branchClient: { send: jest.fn(() => of({ data: null })) },
    lookup: {
      getHqBranchId: jest.fn().mockResolvedValue('1'),
      getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
      getCustomerDistrictId: mocks.getCustomerDistrictId,
      resolveRegionIdForDistrict: mocks.resolveRegionIdForDistrict,
    },
    orderWarehouse: { planCreate: mocks.planCreate },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    findById: jest.fn().mockResolvedValue({ id: '900' }),
  });
  const createdRow = (): Row => {
    expect(mocks.orderCreate).toHaveBeenCalledTimes(1);
    return mocks.orderCreate.mock.calls[0][0];
  };
  const nothingCreated = () => {
    expect(mocks.startTransaction).not.toHaveBeenCalled();
    expect(mocks.orderCreate).not.toHaveBeenCalled();
    expect(mocks.planCreate).not.toHaveBeenCalled();
  };
  return { s, mocks, createdRow, nothingCreated };
}

type CreateDto = Parameters<OrderLifecycleService['create']>[0];
type ExternalDto = Parameters<OrderLifecycleService['createExternalOrder']>[0];

describe('IR2OHIiN — order-service yagona yaratish nuqtasi (create)', () => {
  describe('TC1: mahsulot', () => {
    it.each([
      ['items yo‘q', { items: undefined }, ORDER_CREATE_NO_ITEMS_MESSAGE],
      ['items: []', { items: [] }, ORDER_CREATE_NO_ITEMS_MESSAGE],
      [
        'miqdor 0',
        { items: [{ product_id: '41', quantity: 0 }] },
        ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
      ],
      [
        'manfiy miqdor',
        { items: [{ product_id: '41', quantity: -1 }] },
        ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
      ],
      [
        'qatorlardan biri 0',
        {
          items: [
            { product_id: '41', quantity: 1 },
            { product_id: '42', quantity: 0 },
          ],
        },
        ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
      ],
    ])(
      'POST /orders (market): %s → 400, hech narsa yaratilmaydi',
      async (_l, patch, message) => {
        const h = makeHarness();
        const error = await rpcError(
          h.s.create({ ...BASE, ...patch } as CreateDto, MARKET),
        );
        expect(error).toEqual({ statusCode: 400, message });
        h.nothingCreated();
      },
    );

    it('miqdorsiz qator (sukut 1) — o‘tadi, product_quantity 1', async () => {
      const h = makeHarness();
      await h.s.create(
        { ...BASE, items: [{ product_name: 'Kitob' }] } as CreateDto,
        MARKET,
      );
      expect(h.mocks.itemValues).toHaveBeenCalledWith([
        expect.objectContaining({ product_name: 'Kitob', quantity: 1 }),
      ]);
    });
  });

  describe('TC2: tuman', () => {
    it('⭐ buyurtmada ham, mijozda ham tuman yo‘q → 400 «tuman tanlanmagan»', async () => {
      const h = makeHarness({ customerDistrictId: null });
      const error = await rpcError(
        h.s.create(
          { ...BASE, district_id: null, region_id: null } as CreateDto,
          MARKET,
        ),
      );
      expect(error).toEqual({
        statusCode: 400,
        message: ORDER_CREATE_NO_DISTRICT_MESSAGE,
      });
      expect(h.mocks.getCustomerDistrictId).toHaveBeenCalledWith('801');
      h.nothingCreated();
    });

    it('⭐ tuman faqat mijozda → buyurtmaga YOZILADI, viloyat tumandan', async () => {
      const h = makeHarness({
        customerDistrictId: '45',
        regionForDistrict: '9',
      });
      await h.s.create(
        { ...BASE, district_id: undefined, region_id: undefined } as CreateDto,
        MARKET,
      );
      expect(h.createdRow()).toMatchObject({
        district_id: '45',
        region_id: '9',
      });
      expect(h.mocks.resolveRegionIdForDistrict).toHaveBeenCalledWith('45');
    });

    it('tuman mijozdan olinsa — berilgan (mos kelmasligi mumkin) viloyat emas, tumanniki', async () => {
      const h = makeHarness({
        customerDistrictId: '45',
        regionForDistrict: '9',
      });
      await h.s.create(
        { ...BASE, district_id: '', region_id: '3' } as CreateDto,
        MARKET,
      );
      expect(h.createdRow()).toMatchObject({
        district_id: '45',
        region_id: '9',
      });
    });

    it('buyurtma tumani va viloyati berilgan — o‘zgarmaydi, RPC yo‘q (regressiya)', async () => {
      const h = makeHarness();
      await h.s.create(BASE as CreateDto, MARKET);
      expect(h.createdRow()).toMatchObject({
        district_id: '12',
        region_id: '3',
      });
      expect(h.mocks.getCustomerDistrictId).not.toHaveBeenCalled();
      expect(h.mocks.resolveRegionIdForDistrict).not.toHaveBeenCalled();
    });

    it('tuman bor, viloyat yo‘q (bot) — viloyat tumandan; aniqlanmasa 400, buyurtma yaratilmaydi (ega qoidasi: viloyat ham majburiy)', async () => {
      const h = makeHarness({ regionForDistrict: '5' });
      await h.s.create(
        { ...BASE, region_id: undefined } as CreateDto,
        OPERATOR,
      );
      expect(h.createdRow()).toMatchObject({
        district_id: '12',
        region_id: '5',
      });

      const h2 = makeHarness({ regionForDistrict: null });
      const error = await rpcError(
        h2.s.create({ ...BASE, region_id: undefined } as CreateDto, OPERATOR),
      );
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain('viloyat aniqlanmadi');
      h2.nothingCreated();
    });

    it('identity javob bermasa — 503, buyurtma yaratilmaydi (fail-closed)', async () => {
      const h = makeHarness();
      h.mocks.getCustomerDistrictId.mockRejectedValueOnce(
        new RpcException({ statusCode: 503, message: 'Mijoz tumanini' }),
      );
      const error = await rpcError(
        h.s.create({ ...BASE, district_id: undefined } as CreateDto, MARKET),
      );
      expect(error.statusCode).toBe(503);
      h.nothingCreated();
    });
  });

  describe('TC3: boshqa yo‘llar ham shu qoidaga bo‘ysunadi', () => {
    it('AI ai-confirm (auditMetadata): mahsulotsiz → 400', async () => {
      const h = makeHarness();
      const error = await rpcError(
        h.s.create({ ...BASE, items: [] } as CreateDto, MARKET, {
          auditMetadata: { ai: true },
        }),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_ITEMS_MESSAGE);
      h.nothingCreated();
    });

    it('⭐ Telegram bot (createdVia: bot): tuman faqat mijozda → yoziladi; mahsulotsiz → 400', async () => {
      const h = makeHarness({
        customerDistrictId: '45',
        regionForDistrict: '9',
      });
      await h.s.create(
        { ...BASE, district_id: undefined, region_id: undefined } as CreateDto,
        OPERATOR,
        { createdVia: 'bot' as never },
      );
      expect(h.createdRow()).toMatchObject({
        district_id: '45',
        region_id: '9',
        created_via: 'bot',
      });

      const h2 = makeHarness();
      const error = await rpcError(
        h2.s.create({ ...BASE, items: [] } as CreateDto, OPERATOR, {
          createdVia: 'bot' as never,
        }),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_ITEMS_MESSAGE);
    });

    it.each([
      ['menejer (filial «Qabul va yaratish»)', MANAGER],
      ['registrator', REGISTRATOR],
    ])(
      '⭐ %s: source=branch, tumansiz (№56 holati) → 400; mijozda bo‘lsa yoziladi',
      async (_l, requester) => {
        const h = makeHarness({ customerDistrictId: null });
        const error = await rpcError(
          h.s.create(
            {
              ...BASE,
              district_id: null,
              region_id: null,
              branch_id: '3',
              source: Order_source.BRANCH,
            } as CreateDto,
            requester,
          ),
        );
        expect(error.message).toBe(ORDER_CREATE_NO_DISTRICT_MESSAGE);
        h.nothingCreated();

        const ok = makeHarness({ customerDistrictId: '45' });
        await ok.s.create(
          {
            ...BASE,
            district_id: null,
            region_id: null,
            branch_id: '3',
            source: Order_source.BRANCH,
          } as CreateDto,
          requester,
        );
        expect(ok.createdRow()).toMatchObject({
          district_id: '45',
          source: Order_source.BRANCH,
        });
      },
    );

    it('almashtirish (replaced_order_id): mahsulotsiz → 400 eski buyurtma qulflanishidan OLDIN', async () => {
      const h = makeHarness();
      const error = await rpcError(
        h.s.create(
          { ...BASE, items: [], replaced_order_id: '101' } as CreateDto,
          MARKET,
        ),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_ITEMS_MESSAGE);
      h.nothingCreated();
    });

    it('ombor manbasi (fulfillment: auto): reja mijozdan olingan tuman bilan tuziladi', async () => {
      const h = makeHarness({
        customerDistrictId: '45',
        regionForDistrict: '9',
      });
      await h.s.create(
        {
          ...BASE,
          district_id: undefined,
          region_id: undefined,
          fulfillment: 'auto',
        } as CreateDto,
        REGISTRATOR,
      );
      expect(h.mocks.planCreate).toHaveBeenCalledWith(
        expect.objectContaining({ district_id: '45', region_id: '9' }),
        REGISTRATOR,
      );
    });

    it('⭐ superadmin `source: external` bilan ham chetlab o‘tolmaydi (POST /orders)', async () => {
      const h = makeHarness({ customerDistrictId: null });
      const error = await rpcError(
        h.s.create(
          {
            ...BASE,
            items: [],
            source: Order_source.EXTERNAL,
          } as CreateDto,
          SUPERADMIN,
        ),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_ITEMS_MESSAGE);
      h.nothingCreated();
    });
  });

  describe('POST /orders/external (createExternalOrder) — qo‘lda yaratish, hamkor emas', () => {
    it.each([
      ['so‘rovchisiz', undefined],
      ['market', MARKET],
      ['superadmin', SUPERADMIN],
    ])('%s: mahsulotsiz → 400', async (_l, requester) => {
      const h = makeHarness();
      const error = await rpcError(
        h.s.createExternalOrder(
          { ...BASE, items: [] } as ExternalDto,
          requester as never,
        ),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_ITEMS_MESSAGE);
      h.nothingCreated();
    });

    it('tumansiz → 400; tuman faqat mijozda → yoziladi', async () => {
      const h = makeHarness({ customerDistrictId: null });
      const error = await rpcError(
        h.s.createExternalOrder(
          { ...BASE, district_id: null } as ExternalDto,
          MARKET,
        ),
      );
      expect(error.message).toBe(ORDER_CREATE_NO_DISTRICT_MESSAGE);
      h.nothingCreated();

      const ok = makeHarness({
        customerDistrictId: '45',
        regionForDistrict: '9',
      });
      await ok.s.createExternalOrder(
        { ...BASE, district_id: null, region_id: null } as ExternalDto,
        MARKET,
      );
      expect(ok.createdRow()).toMatchObject({
        district_id: '45',
        region_id: '9',
        source: Order_source.EXTERNAL,
      });
    });
  });

  describe('Hamkor / integratsiya — ATAYLAB chiqarilgan (Shodiyorga alohida karta)', () => {
    it('BeePost hamkor posilkasi (partner:<id>, external): mahsulotsiz ham yaratiladi — avvalgidek', async () => {
      const h = makeHarness();
      await h.s.create(
        {
          ...BASE,
          items: [],
          source: Order_source.EXTERNAL,
          external_id: 'bp-1',
        } as CreateDto,
        PARTNER,
      );
      expect(h.createdRow()).toMatchObject({ source: Order_source.EXTERNAL });
      expect(h.mocks.getCustomerDistrictId).not.toHaveBeenCalled();
    });

    it('tashqi saytlar importi (so‘rovchisiz, external): mahsulotsiz ham yaratiladi — avvalgidek', async () => {
      const h = makeHarness();
      await h.s.create({
        ...BASE,
        items: [],
        source: Order_source.EXTERNAL,
        external_id: 'site-1',
      } as CreateDto);
      expect(h.createdRow()).toMatchObject({ source: Order_source.EXTERNAL });
    });
  });
});

describe('IR2OHIiN — isIntegrationOrderCreate', () => {
  it.each([
    [{ source: 'external' }, PARTNER, true],
    [{ source: 'EXTERNAL' }, undefined, true],
    [{ source: 'external' }, { id: '' }, true],
    [{ source: 'external' }, SUPERADMIN, false],
    [{ source: 'external' }, MARKET, false],
    [{ source: 'internal' }, undefined, false],
    [{ source: 'branch' }, PARTNER, false],
    [{}, undefined, false],
  ])('%j + %j → %s', (dto, requester, expected) => {
    expect(isIntegrationOrderCreate(dto, requester)).toBe(expected);
  });
});

describe('IR2OHIiN — resolveOrderCreateContent', () => {
  const lookup = (customer: string | null, region: string | null) => ({
    getCustomerDistrictId: jest.fn().mockResolvedValue(customer),
    resolveRegionIdForDistrict: jest.fn().mockResolvedValue(region),
  });

  it('raqamli id ham qabul qilinadi; mijoz id siz va tumansiz → 400', async () => {
    await expect(
      resolveOrderCreateContent(
        { items: ITEMS, district_id: 12, region_id: 3 },
        lookup(null, null),
      ),
    ).resolves.toEqual({ district_id: '12', region_id: '3' });
    const error = await rpcError(
      resolveOrderCreateContent({ items: ITEMS }, lookup(null, null)),
    );
    expect(error.message).toBe(ORDER_CREATE_NO_DISTRICT_MESSAGE);
  });

  it('kasr miqdor va matnli miqdor → 400', async () => {
    for (const quantity of [1.5, 'abc', '']) {
      const error = await rpcError(
        resolveOrderCreateContent(
          { items: [{ product_id: '1', quantity }], district_id: '1' },
          lookup(null, null),
        ),
      );
      expect(error.message).toBe(ORDER_CREATE_ITEM_QUANTITY_MESSAGE);
    }
  });
});

describe('IR2OHIiN — OrderLookupService.getCustomerDistrictId', () => {
  const make = (send: jest.Mock) =>
    new OrderLookupService(
      { send } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('mijoz tumani qaytadi', async () => {
    const send = jest.fn(() => of({ data: { id: '801', district_id: 45 } }));
    await expect(make(send).getCustomerDistrictId('801')).resolves.toBe('45');
    expect(send).toHaveBeenCalledWith(
      { cmd: 'identity.customer.find_by_id' },
      { id: '801' },
    );
  });

  it('mijozda tuman yo‘q yoki mijoz topilmadi (404) → null', async () => {
    await expect(
      make(
        jest.fn(() => of({ data: { id: '801', district_id: null } })),
      ).getCustomerDistrictId('801'),
    ).resolves.toBeNull();
    await expect(
      make(
        jest.fn(() =>
          throwError(() => ({
            statusCode: 404,
            message: 'Customer topilmadi',
          })),
        ),
      ).getCustomerDistrictId('801'),
    ).resolves.toBeNull();
  });

  it('raqam bo‘lmagan id — RPC yo‘q, null', async () => {
    const send = jest.fn();
    await expect(
      make(send).getCustomerDistrictId(undefined),
    ).resolves.toBeNull();
    await expect(make(send).getCustomerDistrictId('abc')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('identity ishlamasa — 503 (fail-closed)', async () => {
    const send = jest.fn(() =>
      throwError(() => ({ statusCode: 500, message: 'boom' })),
    );
    const error = await rpcError(make(send).getCustomerDistrictId('801'));
    expect(error.statusCode).toBe(503);
  });
});
