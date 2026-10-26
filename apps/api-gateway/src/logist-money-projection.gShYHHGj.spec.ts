import { of } from 'rxjs';
import { LOGIST_MONEY_KEY_PATTERN } from './auth/order-role-projection';
import {
  LogistRegionScopeService,
  projectLogistPayload,
} from './auth/logist-scope';
import { SearchGatewayController } from './search-gateway.controller';

/**
 * gShYHHGj (2-band) — buyurtma, pochta, paket va qidiruv javoblarida LOGIST
 * uchun pul maydonlari YO'Q (proyeksiya).
 *
 * Buyurtma / pochta / paket (transfer-batch) controller oqimlari mavjud
 * spec'larda (logist-scope.4BftLLnc, logist-money-keys.4BftLLnc,
 * logist-posts-batches-couriers.Z3pUOxou) HTTP darajasida tekshirilgan. Bu
 * yerda: (a) to'rt oila uchun bitta umumiy «daraxtda pul kaliti yo'q»
 * invarianti (bir xil proyeksiya funksiyasi), (b) GET /search — gateway
 * endi o'zi ham proyeksiya qiladi (ilgari search-service javobi o'zgarishsiz
 * uzatilardi; servis o'zgarsa moliya sizardi).
 */

type Tree = unknown;

/** Javob daraxtidagi barcha kalitlar (ichma-ich, massivlar ichida ham). */
const allKeys = (node: Tree, acc: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, acc);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      acc.push(key);
      allKeys(value, acc);
    }
  }
  return acc;
};

const moneyKeys = (node: Tree) =>
  allKeys(node).filter((key) => LOGIST_MONEY_KEY_PATTERN.test(key));

const LOGIST = ['logist'];
const MANAGER = ['manager'];

const order = {
  id: '67',
  status: 'waiting',
  total_price: 50_000,
  market_tariff: 20_000,
  courier_tariff: 15_000,
  to_be_paid: 30_000,
  paid_amount: 0,
  extra_cost: 1_000,
  region_id: '5',
  market: {
    id: '37',
    name: 'TEST market',
    tariff_center: 20_000,
    tariff_home: 25_000,
  },
  items: [{ quantity: 1, product: { name: 'Choynak', price: 99_000 } }],
};

const FAMILIES: Array<[string, Tree]> = [
  ['GET /orders (ro‘yxat)', { data: [order], total: 1 }],
  ['GET /orders/:id', { data: order }],
  [
    'GET /post (pochta)',
    {
      data: [
        {
          id: '9',
          status: 'sent',
          post_total_price: 150_000,
          order_quantity: 3,
          orders: [order],
        },
      ],
    },
  ],
  [
    'GET /transfer-batches (paket)',
    {
      data: {
        items: [
          {
            id: '4',
            status: 'sent',
            total_amount: 120_000,
            orders_count: 2,
            orders: [order],
          },
        ],
      },
    },
  ],
  [
    'GET /search (qidiruv)',
    {
      data: {
        items: [
          {
            id: '1',
            source: 'order',
            type: 'order',
            sourceId: '67',
            title: '№67',
            metadata: { total_price: 50_000, region_id: '5' },
            amount: 50_000,
          },
        ],
      },
    },
  ],
];

describe('gShYHHGj — LOGIST proyeksiyasi: buyurtma, pochta, paket, qidiruv', () => {
  it.each(FAMILIES)(
    '%s: proyeksiyadan oldin pul bor (spec soxta emas)',
    (_name, payload) => {
      expect(moneyKeys(payload).length).toBeGreaterThan(0);
    },
  );

  it.each(FAMILIES)(
    '%s: logist javobida pul kaliti YO‘Q, operatsion maydonlar qoladi',
    (_name, payload) => {
      const projected = projectLogistPayload(LOGIST, structuredClone(payload));
      expect(moneyKeys(projected)).toEqual([]);
      const keys = allKeys(projected);
      expect(keys).toEqual(expect.arrayContaining(['id']));
    },
  );

  it.each(FAMILIES)(
    '%s: menejer javobi o‘zgarmaydi (asl havola)',
    (_name, payload) => {
      expect(projectLogistPayload(MANAGER, payload)).toBe(payload);
    },
  );
});

describe('gShYHHGj — GET /search (gateway) logist javobi pulsiz', () => {
  const searchReply = FAMILIES[4][1];
  const setup = () => {
    const search = { send: jest.fn(() => of(structuredClone(searchReply))) };
    const identity = { send: jest.fn(() => of({ data: {} })) };
    const scope = new LogistRegionScopeService({
      send: jest.fn(() => of({ statusCode: 200, data: { region_ids: ['5'] } })),
    } as never);
    return new SearchGatewayController(
      search as never,
      identity as never,
      scope,
    );
  };

  it('logist: search-service pul qaytarsa ham gateway olib tashlaydi', async () => {
    const res = await setup().query(
      '67',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        user: { sub: '77', username: 'l', roles: ['logist'] },
      },
    );
    expect(moneyKeys(res)).toEqual([]);
    expect(JSON.stringify(res)).toContain('№67');
  });

  it('admin: javob o‘zgarishsiz (pul maydonlari qoladi)', async () => {
    const res = await setup().query(
      '67',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        user: { sub: '1', username: 'a', roles: ['admin'] },
      },
    );
    expect(res).toEqual(searchReply);
  });
});
