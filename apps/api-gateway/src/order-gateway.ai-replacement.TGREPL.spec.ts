import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { NEVER, type Observable, of, throwError } from 'rxjs';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { Where_deliver } from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import type { AiStatusPoller } from './ai/ai-status.poller';
import { setSharpForTesting } from './ai-order/ai-image-resize';
import {
  AiConfirmRequestDto,
  type AiConfirmOrderDto,
} from './dto/ai-order.swagger.dto';

/**
 * TGREPL — Telegram AI bot almashtirishi (BeePost kabi), gateway qismi:
 *  - ai-parse: `is_replacement` preview'iga telefon (oxirgi 9 raqam, aniq
 *    moslik) bo'yicha SHU marketning eski buyurtmasi — `GET
 *    /orders/replaceable` bilan AYNI yo'l (identity `customer.search` →
 *    `order.replaceable`), eng yangisi avto-tanlanadi; xato — preview
 *    baribir qaytadi, lekin `unavailable` ("topilmadi" emas);
 *  - ai-confirm: `replaced_order_id` `order.create` ga (market — server
 *    aniqlagan so'rovchi marketi), narxsiz — 0, dublikat imzosida.
 */

type Pattern = { cmd: string };
/** Soxta RMQ mijozlariga kelgan payload (testlar o'qiydigan maydonlar). */
type Payload = {
  id?: string;
  ids?: string[];
  market_id?: string;
  request_id?: string;
  ai_signature?: string;
  limit?: number;
  dto?: {
    phone_number?: string;
    market_id?: string;
    replaced_order_id?: string;
    total_price?: number;
  };
};
type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, Payload]> };

const fakeClient = (): Fake => ({
  send: jest.fn<Observable<unknown>, [Pattern, Payload]>(),
});
const asClient = (fake: Fake) => fake as unknown as ClientProxy;
const sendsOf = (fake: Fake, cmd: string) =>
  fake.send.mock.calls.filter(([pattern]) => pattern.cmd === cmd);
/** jest asimmetrik matcher'i `any` qaytaradi — `unknown` ga toraytiriladi. */
const stringContaining = (fragment: string): unknown =>
  expect.stringContaining(fragment);

const MARKET_ID = '77';
const OPERATOR_MARKET_ID = '37';
const PHONE = '+998901234567';

const marketReq = {
  user: { sub: MARKET_ID, username: 'market', roles: ['market'] },
};
const operatorReq = {
  user: { sub: '501', username: 'op', roles: ['market_operator'] },
};

const preview = (extra: Record<string, unknown> = {}) => ({
  index: 0,
  ready: false,
  issues: ['price_missing'],
  customer_name: 'Ali',
  phone_number: PHONE,
  extra_number: null,
  region_id: '1',
  region_name: 'Toshkent shahri',
  region_given: true,
  district_id: '12',
  district_name: 'Chilonzor',
  district_candidates: [],
  address: null,
  items: [
    {
      name: 'atir',
      quantity: 1,
      product_id: '15',
      resolved_name: 'Atir 50 ml',
      candidates: [],
      unresolved: false,
    },
  ],
  total_price: null,
  price_confirmed: false,
  where_deliver: 'center',
  comment: '[ALMASHTIRISH]',
  is_replacement: true,
  operator: null,
  warnings: [],
  ...extra,
});

/** `order.replaceable` qatori (order-service `toRow`, `createdAt` — ISO). */
const replaceableRow = (
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  status: 'sold',
  market_id: MARKET_ID,
  customer_id: '120',
  total_price: 150000,
  where_deliver: 'center',
  comment: null,
  sold_at: null,
  createdAt,
  items: [{ product_id: '15', product_name: null, quantity: 2 }],
  ...extra,
});

const makeController = (
  opts: {
    previews?: unknown[];
    rows?: unknown[];
    /** `order.replaceable` `total` (berilmasa — qatorlar soni). */
    total?: number;
    customerSearch?: () => Observable<unknown>;
    replaceable?: () => Observable<unknown>;
  } = {},
) => {
  const order = fakeClient();
  const identity = fakeClient();
  const logistics = fakeClient();
  const branch = fakeClient();
  const file = fakeClient();
  const ai = fakeClient();
  const catalog = fakeClient();
  const config = {
    get: jest.fn((key: string) =>
      key === 'AI_ORDER_ENABLED' ? true : undefined,
    ),
  };
  const poller = { getState: jest.fn(() => 'enabled') };

  ai.send.mockImplementation((pattern) =>
    pattern.cmd === 'ai.order.extract'
      ? of({ ok: true, orders: [{ customer_name: 'Ali' }] })
      : of({ updated: 1 }),
  );
  let nextOrderId = 1000;
  order.send.mockImplementation((pattern, payload) => {
    if (pattern.cmd === 'order.ai_resolve_preview') {
      return of({ previews: opts.previews ?? [preview()] });
    }
    if (pattern.cmd === 'order.replaceable') {
      if (opts.replaceable) return opts.replaceable();
      const items = (opts.rows ?? []).filter(
        (row) =>
          (row as { market_id?: string }).market_id === payload.market_id,
      );
      return of({
        statusCode: 200,
        data: {
          // order-service kabi `limit` bo'yicha qirqiladi.
          items: items.slice(0, payload.limit ?? 20),
          total: opts.total ?? items.length,
          page: 1,
          limit: payload.limit,
        },
      });
    }
    return of({ id: String(nextOrderId++) });
  });
  identity.send.mockImplementation((pattern, payload) => {
    if (pattern.cmd === 'identity.customer.search') {
      return opts.customerSearch
        ? opts.customerSearch()
        : of({
            success: true,
            data: [
              { id: '120', phone_number: PHONE },
              { id: 'x', phone_number: PHONE },
            ],
          });
    }
    if (pattern.cmd === 'identity.user.find_by_id') {
      return of({ data: { id: payload.id, market_id: OPERATOR_MARKET_ID } });
    }
    if (pattern.cmd === 'identity.market.find_by_id') {
      return of({
        data: { id: payload.id, status: 'active', add_order: true },
      });
    }
    if (pattern.cmd === 'identity.customer.create') {
      return of({ data: { id: `c${payload.dto?.phone_number ?? ''}` } });
    }
    return of({ data: null });
  });
  logistics.send.mockImplementation((_pattern, payload) =>
    of({
      data: [{ id: '12', region_id: '1', isDeleted: false }].filter((d) =>
        (payload.ids ?? []).includes(d.id),
      ),
    }),
  );
  catalog.send.mockImplementation((_pattern, payload) =>
    of({
      data: [
        { id: '15', name: 'Atir 50 ml', user_id: MARKET_ID },
        { id: '16', name: 'Krem', user_id: OPERATOR_MARKET_ID },
      ].filter((p) => (payload.ids ?? []).includes(p.id)),
    }),
  );

  const controller = new OrderGatewayController(
    asClient(order),
    asClient(identity),
    asClient(logistics),
    asClient(branch),
    asClient(file),
    asClient(ai),
    asClient(catalog),
    config as unknown as ConfigService,
    poller as unknown as AiStatusPoller,
  );
  return { controller, order, identity, catalog, ai };
};

type ParsedOrder = Record<string, unknown>;
const parsedOrders = (res: { data: { orders?: unknown[] } }) =>
  (res.data.orders ?? []) as ParsedOrder[];

describe('TGREPL — POST /orders/ai-parse: almashtirish eski buyurtmasi', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    setSharpForTesting(null);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    setSharpForTesting(undefined);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ MARKET: shu marketning eng YANGI yetkazilgan buyurtmasi avto-tanlanadi; boshqa market qatori tushmaydi', async () => {
    const fx = makeController({
      rows: [
        replaceableRow('300', '2026-10-01T10:00:00.000Z'),
        replaceableRow('310', '2026-10-20T10:00:00.000Z'),
        replaceableRow('320', '2026-10-25T10:00:00.000Z', {
          market_id: '88',
        }),
      ],
    });
    const res = await fx.controller.aiParse(
      { text: 'Ali 901234567 atir buzuq, almashtirib bering' },
      [],
      marketReq,
    );

    expect(res.data.ok).toBe(true);
    const [order] = parsedOrders(res);
    expect(order.replacement_lookup).toBe('found');
    expect(order.replaced_order_id).toBe('310');
    expect(order.replacement_candidates_total).toBe(2);
    expect(order.replacement_candidates).toEqual([
      {
        id: '310',
        order_number: 'EL-100310',
        created_at: '2026-10-20T10:00:00.000Z',
        // Mahsulot nomi katalogdan (order_items.product_name bo'sh).
        items: 'Atir 50 ml ×2',
        total_price: 150000,
      },
      expect.objectContaining({ id: '300' }),
    ]);
    // Narx so'ralmaydi — price_missing olib tashlandi.
    expect(order.issues).toEqual([]);
    expect(order.ready).toBe(true);
    expect(order.total_price).toBeNull();

    // GET /orders/replaceable telefon yo'li bilan AYNI RPC'lar.
    expect(sendsOf(fx.identity, 'identity.customer.search')).toEqual([
      [{ cmd: 'identity.customer.search' }, { search: '901234567', limit: 50 }],
    ]);
    expect(sendsOf(fx.order, 'order.replaceable')).toEqual([
      [
        { cmd: 'order.replaceable' },
        {
          market_id: MARKET_ID,
          customer_ids: ['120'],
          page: 1,
          // Keng sahifa: eng yangisi gateway'da yaratilgan vaqt bo'yicha.
          limit: 100,
        },
      ],
    ]);
  });

  it('⭐ telefon raqamlari ichida izlangan raqam bor BEGONA mijoz olinmaydi (oxirgi 9 raqam aniq)', async () => {
    const fx = makeController({
      // A: +998 98 901 23 45; B: +998 90 123 45 67 (raqamlarida 989012345 bor).
      previews: [preview({ phone_number: '+998989012345' })],
      customerSearch: () =>
        of({
          success: true,
          data: [
            { id: '121', phone_number: '+998989012345', matched_by: 'phone' },
            { id: '122', phone_number: '+998901234567', matched_by: 'phone' },
            { id: '123', name: '989012345', phone_number: '+998911111111' },
          ],
        }),
      rows: [
        replaceableRow('310', '2026-10-20T10:00:00.000Z', {
          customer_id: '121',
        }),
      ],
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    expect(sendsOf(fx.order, 'order.replaceable')[0][1]).toMatchObject({
      customer_ids: ['121'],
    });
    expect(parsedOrders(res)[0].replaced_order_id).toBe('310');
  });

  it('identity faqat begona (o‘rtadan mos) mijozni qaytarsa — not_found, order.replaceable chaqirilmaydi', async () => {
    const fx = makeController({
      previews: [preview({ phone_number: '+998989012345' })],
      customerSearch: () =>
        of({
          success: true,
          data: [{ id: '122', phone_number: '+998901234567' }],
        }),
      rows: [replaceableRow('310', '2026-10-20T10:00:00.000Z')],
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    const [order] = parsedOrders(res);
    expect(order.replacement_lookup).toBe('not_found');
    expect(order.replaced_order_id).toBeNull();
    expect(sendsOf(fx.order, 'order.replaceable')).toHaveLength(0);
  });

  it('⭐ 10 tadan ko‘p mos buyurtma (sold_at tartibida): eng YANGI yaratilgani tanlanadi, total uzatiladi', async () => {
    // order-service tartibi — sold_at DESC: eng yangi yaratilgan (500) eng
    // oxirida (erta sotilgan), 10 talik sahifaga tushmasdi.
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        replaceableRow(
          String(400 + i),
          `2026-10-${String(10 + i)}T10:00:00.000Z`,
        ),
      ),
      replaceableRow('500', '2026-11-03T10:00:00.000Z'),
    ];
    const fx = makeController({ rows });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    const [order] = parsedOrders(res);
    expect(order.replaced_order_id).toBe('500');
    expect(order.replacement_candidates).toHaveLength(10);
    expect(order.replacement_candidates_total).toBe(13);
  });

  it('MARKET_OPERATOR: market identity user.market_id dan (tanadagi market_id e’tiborsiz)', async () => {
    const fx = makeController({
      rows: [
        replaceableRow('410', '2026-10-20T10:00:00.000Z', {
          market_id: OPERATOR_MARKET_ID,
        }),
        replaceableRow('300', '2026-10-30T10:00:00.000Z'),
      ],
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish', market_id: '999' },
      [],
      operatorReq,
    );
    const [order] = parsedOrders(res);
    expect(order.replaced_order_id).toBe('410');
    expect(order.replacement_candidates).toHaveLength(1);
    expect(sendsOf(fx.order, 'order.replaceable')[0][1]).toMatchObject({
      market_id: OPERATOR_MARKET_ID,
    });
  });

  it('telefon 9 raqamdan kam — qidirilmaydi (not_found); preview nomzodsiz, narx kamchiligi qoladi', async () => {
    const fx = makeController({
      previews: [preview({ phone_number: '12345678' })],
      rows: [replaceableRow('310', '2026-10-20T10:00:00.000Z')],
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    const [order] = parsedOrders(res);
    expect(order.replacement_lookup).toBe('not_found');
    expect(order.replaced_order_id).toBeNull();
    expect(order.replacement_candidates).toEqual([]);
    expect(order.issues).toEqual(['price_missing']);
    expect(sendsOf(fx.identity, 'identity.customer.search')).toHaveLength(0);
    expect(sendsOf(fx.order, 'order.replaceable')).toHaveLength(0);
  });

  it('eski buyurtma topilmadi — oddiy buyurtma (nomzodsiz, kamchiliklar o‘zgarmaydi)', async () => {
    const fx = makeController({ rows: [] });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    const [order] = parsedOrders(res);
    expect(order.replacement_lookup).toBe('not_found');
    expect(order.replaced_order_id).toBeNull();
    expect(order.replacement_candidates).toEqual([]);
    expect(order.issues).toEqual(['price_missing']);
  });

  it('⭐ qidiruv xatosi — ai-parse baribir preview qaytaradi (unavailable, "topilmadi" emas), telefon log’ga tushmaydi', async () => {
    const fx = makeController({
      customerSearch: () => throwError(() => new Error(`down ${PHONE}`)),
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    expect(res.data.ok).toBe(true);
    const [order] = parsedOrders(res);
    expect(order.replacement_lookup).toBe('unavailable');
    expect(order.replaced_order_id).toBeNull();
    expect(order.replacement_candidates).toEqual([]);
    expect(order.customer_name).toBe('Ali');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('almashtirish nomzodlari olinmadi');
    expect(logged).not.toContain('901234567');
  });

  it('order.replaceable javob bermasa — 4s byudjetdan keyin unavailable preview', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const fx = makeController({ replaceable: () => NEVER });
    const pending = fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    await jest.advanceTimersByTimeAsync(4_000);
    const res = await pending;
    expect(res.data.ok).toBe(true);
    expect(parsedOrders(res)[0].replaced_order_id).toBeNull();
    expect(parsedOrders(res)[0].replacement_lookup).toBe('unavailable');
  });

  it('⭐ bir telefonli uch almashtirish — bitta qidiruv; har biriga BOSHQA eski buyurtma, qolmasa taken; oddiy buyurtmaga tegilmaydi', async () => {
    const plain = preview({
      index: 3,
      is_replacement: false,
      total_price: 90000,
      issues: [],
      ready: true,
    });
    const fx = makeController({
      previews: [
        preview(),
        preview({ index: 1 }),
        preview({ index: 2 }),
        plain,
      ],
      rows: [
        replaceableRow('310', '2026-10-20T10:00:00.000Z'),
        replaceableRow('290', '2026-10-05T10:00:00.000Z'),
      ],
    });
    const res = await fx.controller.aiParse(
      { text: 'almashtirish' },
      [],
      marketReq,
    );
    const orders = parsedOrders(res);
    expect(orders.map((o) => o.replaced_order_id ?? 'none')).toEqual([
      '310',
      '290',
      'none',
      'none',
    ]);
    expect(orders.map((o) => o.replacement_lookup ?? 'none')).toEqual([
      'found',
      'found',
      'taken',
      'none',
    ]);
    // Band bo'lsa narx kamchiligi qoladi (oddiy buyurtma emas — kabinetda).
    expect(orders[2].issues).toEqual(['price_missing']);
    expect(orders[3]).not.toHaveProperty('replacement_candidates');
    expect(sendsOf(fx.identity, 'identity.customer.search')).toHaveLength(1);
  });

  it('almashtirishsiz partiyada qidiruv RPC’lari umuman yo‘q', async () => {
    const fx = makeController({
      previews: [preview({ is_replacement: false })],
    });
    await fx.controller.aiParse({ text: 'oddiy' }, [], marketReq);
    expect(sendsOf(fx.identity, 'identity.customer.search')).toHaveLength(0);
    expect(sendsOf(fx.order, 'order.replaceable')).toHaveLength(0);
  });
});

const confirmOrder = (
  n: number,
  extra: Partial<AiConfirmOrderDto> = {},
): AiConfirmOrderDto => ({
  customer: { name: `Mijoz ${n}`, phone_number: PHONE, district_id: '12' },
  district_id: '12',
  items: [{ product_id: '15', quantity: 1 }],
  total_price: 0,
  where_deliver: Where_deliver.CENTER,
  ...extra,
});

const createCalls = (order: Fake) => sendsOf(order, 'order.create');

describe('TGREPL — POST /orders/ai-confirm: replaced_order_id', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ order.create ga replaced_order_id; narx berilmasa 0; market — so‘rovchiniki (tanadagi e’tiborsiz)', async () => {
    const fx = makeController();
    const order = confirmOrder(1, { replaced_order_id: '555' });
    delete (order as Partial<AiConfirmOrderDto>).total_price;
    const res = await fx.controller.aiConfirm(
      { market_id: '999', orders: [order] },
      marketReq,
    );
    expect(res.data.results).toEqual([
      expect.objectContaining({ index: 0, ok: true }),
    ]);
    const [[, payload]] = createCalls(fx.order);
    expect(payload.dto).toMatchObject({
      market_id: MARKET_ID,
      replaced_order_id: '555',
      total_price: 0,
    });
  });

  it('MARKET_OPERATOR: eski buyurtma operator marketi doirasida tekshiriladi', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      {
        market_id: '999',
        orders: [
          confirmOrder(1, {
            replaced_order_id: '555',
            items: [{ product_id: '16', quantity: 1 }],
          }),
        ],
      },
      operatorReq,
    );
    const [[, payload]] = createCalls(fx.order);
    expect(payload.dto).toMatchObject({
      market_id: OPERATOR_MARKET_ID,
      replaced_order_id: '555',
    });
  });

  it('oddiy buyurtmada replaced_order_id YUBORILMAYDI', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { total_price: 150000 })] },
      marketReq,
    );
    const [[, payload]] = createCalls(fx.order);
    expect(payload.dto).not.toHaveProperty('replaced_order_id');
  });

  it('⭐ faqat replaced_order_id bilan farqlanadigan ikki almashtirish — IKKALASI yaratiladi (dublikat emas)', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { replaced_order_id: '555' }),
          confirmOrder(1, { replaced_order_id: '556' }),
        ],
      },
      marketReq,
    );
    expect(res.data.results.map((r) => r.code ?? 'ok')).toEqual(['ok', 'ok']);
    const calls = createCalls(fx.order);
    expect(calls).toHaveLength(2);
    expect(calls.map(([, p]) => p.dto?.replaced_order_id)).toEqual([
      '555',
      '556',
    ]);
    // `ai-dedupe:<imzo>` kalitlari ham turli.
    expect(calls[0][1].request_id).not.toBe(calls[1][1].request_id);
  });

  it('barqaror kalit yo‘lida ham (draft_id + index) mazmun imzosi turli', async () => {
    const fx = makeController();
    const draftId = '3f9b1c9e-5a7d-4c1e-9b3a-2d4e6f8a0b1c';
    await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, {
            replaced_order_id: '555',
            draft_id: draftId,
            ai_item_index: 0,
          }),
          confirmOrder(1, {
            replaced_order_id: '556',
            draft_id: draftId,
            ai_item_index: 1,
          }),
        ],
      },
      marketReq,
    );
    const calls = createCalls(fx.order);
    expect(calls).toHaveLength(2);
    expect(calls[0][1].ai_signature).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0][1].ai_signature).not.toBe(calls[1][1].ai_signature);
  });

  it('AYNI eski buyurtma bilan takror — duplicate_in_batch (bittasi yaratiladi)', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { replaced_order_id: '555' }),
          confirmOrder(1, { replaced_order_id: '555' }),
        ],
      },
      marketReq,
    );
    expect(res.data.results.map((r) => r.code ?? 'ok')).toEqual([
      'ok',
      'duplicate_in_batch',
    ]);
    expect(createCalls(fx.order)).toHaveLength(1);
  });

  it('order-service rad etsa (begona/yetkazilmagan eski buyurtma) — create_failed, sababi bilan', async () => {
    const fx = makeController();
    const base = fx.order.send.getMockImplementation()!;
    fx.order.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'order.create'
        ? throwError(() => ({
            statusCode: 400,
            message:
              'Almashtiriladigan buyurtma #555 shu marketda topilmadi — faqat shu marketning yetkazilgan buyurtmasini tanlash mumkin',
          }))
        : base(pattern, payload),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { replaced_order_id: '555' })] },
      marketReq,
    );
    expect(res.data.results[0]).toMatchObject({
      ok: false,
      code: 'create_failed',
      reason: stringContaining('#555 shu marketda topilmadi'),
    });
  });
});

describe('TGREPL — AiConfirmOrderDto.replaced_order_id', () => {
  const flatten = (errors: ValidationError[], prefix = ''): string[] =>
    errors.flatMap((error) => {
      const path = prefix ? `${prefix}.${error.property}` : error.property;
      const own = error.constraints ? [path] : [];
      return [...own, ...flatten(error.children ?? [], path)];
    });
  const errorPaths = async (order: Record<string, unknown>) => {
    const dto = plainToInstance(AiConfirmRequestDto, { orders: [order] });
    return flatten(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    );
  };
  const base = (extra: Record<string, unknown> = {}) => ({
    customer: { name: 'Ali', phone_number: PHONE, district_id: '12' },
    district_id: '12',
    items: [{ product_id: '15', quantity: 1 }],
    total_price: 150000,
    where_deliver: 'center',
    ...extra,
  });

  it('raqamli id (satr yoki son) qabul qilinadi', async () => {
    expect(await errorPaths(base({ replaced_order_id: '555' }))).toEqual([]);
    const dto = plainToInstance(AiConfirmRequestDto, {
      orders: [base({ replaced_order_id: 555 })],
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.orders[0].replaced_order_id).toBe('555');
  });

  it('raqam bo‘lmagan id — 400 (POST /orders bilan AYNI qoida)', async () => {
    for (const bad of ['abc', '12a', '', '1'.repeat(19), { id: 1 }]) {
      expect(await errorPaths(base({ replaced_order_id: bad }))).toContain(
        'orders.0.replaced_order_id',
      );
    }
  });

  it('narxsiz buyurtma faqat replaced_order_id bilan o‘tadi', async () => {
    const withoutPrice = base({ replaced_order_id: '555' });
    delete (withoutPrice as Record<string, unknown>).total_price;
    expect(await errorPaths(withoutPrice)).toEqual([]);
    const plain = base();
    delete (plain as Record<string, unknown>).total_price;
    expect(await errorPaths(plain)).toContain('orders.0.total_price');
    // Narx berilsa — odatdagi qoida (manfiy — xato).
    expect(
      await errorPaths(base({ replaced_order_id: '555', total_price: -1 })),
    ).toContain('orders.0.total_price');
  });
});
