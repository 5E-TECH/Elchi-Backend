import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import {
  defer,
  finalize,
  map,
  NEVER,
  type Observable,
  of,
  throwError,
  timer,
} from 'rxjs';
import { Where_deliver } from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import type { AiStatusPoller } from './ai/ai-status.poller';
import type {
  AiConfirmCustomerDto,
  AiConfirmOrderDto,
} from './dto/ai-order.swagger.dto';

/** Nest route metadata'si metod funksiyasining o'zida saqlanadi. */
const handlerOf = (name: keyof OrderGatewayController): object =>
  Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
    ?.value as object;

/**
 * POST /orders/ai-confirm (wgqxS0Cp #6-8, #10-13; 32fNx0Ci #9-11).
 *
 * Tuman/mahsulot "bazasi" soxta logistics/catalog mijozlarida: find_by_ids
 * so'ralgan id'lardan borlarini qaytaradi (DB `In(ids)` kabi).
 */

type Pattern = { cmd: string };

/**
 * RPC payloadidagi `dto` — `order.create` da buyurtma, `identity.customer.create`
 * da mijoz. Faqat testlar o'qiydigan maydonlar.
 */
type SentDto = {
  market_id?: string;
  customer_id?: string;
  phone_number?: string;
  district_id?: string;
  region_id?: string;
  operator?: string | null;
  operator_id?: string | null;
  branch_id?: string | null;
  source?: string;
  status?: string;
};

/** Soxta RMQ mijozlariga kelgan payload (testlar o'qiydigan maydonlar). */
type SendPayload = {
  ids?: string[];
  id?: string;
  dto?: SentDto;
  requester?: { id: string; roles: string[] };
  request_id?: string;
  draft_id?: string;
  order_ids?: string[];
  market_id?: string;
};

type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, SendPayload]> };

const fakeClient = (): Fake => ({
  send: jest.fn<Observable<unknown>, [Pattern, SendPayload]>(),
});
const asClient = (fake: Fake) => fake as unknown as ClientProxy;

/** jest asimmetrik matcher'i `any` qaytaradi — `unknown` ga toraytiriladi. */
const stringContaining = (fragment: string): unknown =>
  expect.stringContaining(fragment);

const MARKET_ID = '77';

const DISTRICTS = [
  { id: '12', name: 'Chilonzor', region_id: '1', isDeleted: false },
  { id: '13', name: 'Yunusobod', region_id: '1', isDeleted: false },
  { id: '20', name: 'Chirchiq', region_id: '7', isDeleted: false },
  { id: '30', name: "O'chirilgan", region_id: '1', isDeleted: true },
];

const PRODUCTS = [
  { id: '15', name: 'Atir 50 ml', user_id: MARKET_ID },
  { id: '16', name: 'Krem', user_id: MARKET_ID },
  { id: '99', name: 'Boshqa market mahsuloti', user_id: '555' },
];

const phoneFor = (n: number) => `+998901${String(n).padStart(6, '0')}`;

type ConfirmOverrides = Omit<Partial<AiConfirmOrderDto>, 'customer'> & {
  customer?: Partial<AiConfirmCustomerDto>;
};

/** Frontend `buildAiConfirmPayload` shaklidagi bitta buyurtma. */
const confirmOrder = (
  n: number,
  overrides: ConfirmOverrides = {},
): AiConfirmOrderDto => {
  const { customer: customerPatch, ...rest } = overrides;
  const districtId = rest.district_id ?? '12';
  return {
    customer: {
      name: `Mijoz ${n}`,
      phone_number: phoneFor(n),
      district_id: districtId,
      ...customerPatch,
    },
    district_id: districtId,
    items: [{ product_id: '15', quantity: 1 }],
    total_price: 100000 + n,
    where_deliver: Where_deliver.CENTER,
    ...rest,
  };
};

const makeController = () => {
  const order = fakeClient();
  const identity = fakeClient();
  const logistics = fakeClient();
  const branch = fakeClient();
  const file = fakeClient();
  const ai = fakeClient();
  const catalog = fakeClient();
  const config = { get: jest.fn(() => undefined) };
  const poller = { getState: jest.fn(() => 'enabled') };

  logistics.send.mockImplementation((_pattern, payload) =>
    of({
      statusCode: 200,
      message: 'success',
      data: DISTRICTS.filter((d) => (payload.ids ?? []).includes(d.id)),
    }),
  );
  catalog.send.mockImplementation((_pattern, payload) =>
    of({
      data: PRODUCTS.filter((p) => (payload.ids ?? []).includes(p.id)),
    }),
  );
  identity.send.mockImplementation((pattern, payload) => {
    if (pattern.cmd === 'identity.customer.create') {
      return of({ data: { id: `c${payload.dto?.phone_number ?? ''}` } });
    }
    if (pattern.cmd === 'identity.user.find_by_id') {
      return of({ data: { id: payload.id, market_id: MARKET_ID } });
    }
    // UER0MpMX: partiya boshida market tekshiruvi.
    if (pattern.cmd === 'identity.market.find_by_id') {
      return of({
        data: { id: payload.id, status: 'active', add_order: true },
      });
    }
    return of({ data: null });
  });
  let nextOrderId = 1000;
  order.send.mockImplementation(() => of({ id: String(nextOrderId++) }));
  ai.send.mockImplementation(() => of({ updated: 1 }));

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
  return { controller, order, identity, logistics, branch, ai, catalog };
};

const marketReq = {
  user: { sub: MARKET_ID, username: 'market', roles: ['market'] },
};
const operatorReq = {
  user: { sub: '501', username: 'op', roles: ['market_operator'] },
};
const adminReq = { user: { sub: '1', username: 'admin', roles: ['admin'] } };

const sendsOf = (fake: Fake, cmd: string) =>
  fake.send.mock.calls.filter(([pattern]) => pattern.cmd === cmd);
const orderCreateCalls = (order: Fake) => sendsOf(order, 'order.create');

/** n-chi `order.create` chaqiruvining payloadi. */
const orderCreatePayload = (order: Fake, n = 0): SendPayload => {
  const call = orderCreateCalls(order)[n];
  if (!call) throw new Error(`order.create #${n} chaqirilmagan`);
  return call[1];
};
/** n-chi `order.create` ga ketgan buyurtma `dto` si. */
const createdDto = (order: Fake, n = 0): SentDto => {
  const { dto } = orderCreatePayload(order, n);
  if (!dto) throw new Error(`order.create #${n} payloadida dto yo'q`);
  return dto;
};

describe('OrderGatewayController — POST /orders/ai-confirm', () => {
  beforeEach(() => {
    // Kutilgan WARN'lar (validation_unavailable, link_orders) test chiqishini to'ldirmasin.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('dekoratorlar: HTTP 200 va 6 ta rol', () => {
    const handler = handlerOf('aiConfirm');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(
      expect.arrayContaining([
        'superadmin',
        'admin',
        'registrator',
        'manager',
        'market',
        'market_operator',
      ]),
    );
  });

  it('muvaffaqiyat: {results:[{index, ok, order_id}]} va to‘g‘ri mapping', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, {
            address: 'Chilonzor 5-uy',
            comment: 'Kechqurun',
            operator: 'sevinch',
            customer: { extra_number: '97-111-22-33', address: 'Chilonzor' },
            items: [
              { product_id: '15', quantity: 2 },
              {
                product_name: 'Katalogda yo‘q',
                quantity: 1,
                allow_unlisted_product: true,
              },
            ],
          }),
        ],
      },
      marketReq,
    );

    expect(res).toEqual({
      statusCode: 200,
      message: 'success',
      data: { results: [{ index: 0, ok: true, order_id: '1000' }] },
    });

    const [customerCall] = sendsOf(fx.identity, 'identity.customer.create');
    expect(customerCall?.[1]).toEqual({
      dto: {
        name: 'Mijoz 1',
        phone_number: phoneFor(1),
        district_id: '12',
        extra_number: '97-111-22-33',
        address: 'Chilonzor',
      },
    });

    const payload = orderCreatePayload(fx.order);
    expect(payload.dto).toEqual(
      expect.objectContaining({
        market_id: MARKET_ID,
        customer_id: `c${phoneFor(1)}`,
        district_id: '12',
        region_id: '1',
        address: 'Chilonzor 5-uy',
        where_deliver: 'center',
        total_price: 100001,
        comment: 'Kechqurun',
        operator: 'sevinch',
        items: [
          { product_id: '15', quantity: 2 },
          { product_name: 'Katalogda yo‘q', quantity: 1 },
        ],
      }),
    );
    // Faqat ruxsat etilgan maydonlar — AI/DTO qoldiqlari o'tmaydi.
    expect(JSON.stringify(payload.dto)).not.toContain('allow_unlisted_product');
    expect(payload.dto).not.toHaveProperty('customer');
    expect(payload.dto).not.toHaveProperty('draft_id');
    expect(payload.requester).toEqual({ id: MARKET_ID, roles: ['market'] });
  });

  it('#10 status YUBORILMAYDI (sukut NEW); source/branch_id DTO’dan olinmaydi', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    const dto = createdDto(fx.order);
    expect(dto.status).toBeUndefined();
    expect('status' in dto).toBe(false);
    expect(dto.source).toBeUndefined();
    expect(dto.branch_id).toBeNull();
  });

  it('#6 mavjud bo‘lmagan (yoki o‘chirilgan) tuman — o‘sha buyurtma ok:false, qolganlari yaratiladi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1),
          confirmOrder(2, { district_id: '999999' }),
          confirmOrder(3, { district_id: '13' }),
          confirmOrder(4, { district_id: '30' }),
        ],
      },
      marketReq,
    );
    const { results } = res.data;
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect(results[1]).toEqual(
      expect.objectContaining({ index: 1, code: 'district_not_found' }),
    );
    expect(typeof results[1].reason).toBe('string');
    expect(results[3].code).toBe('district_not_found');
    expect(orderCreateCalls(fx.order)).toHaveLength(2);
  });

  it('#7 mijoz yuborgan region_id E’TIBORSIZ — region_id tuman yozuvidan', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      {
        orders: [confirmOrder(1, { district_id: '20', region_id: '999' })],
      },
      marketReq,
    );
    const dto = createdDto(fx.order);
    expect(dto.district_id).toBe('20');
    expect(dto.region_id).toBe('7');
  });

  it('customer.district_id ≠ district_id → district_mismatch, yaratilmaydi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [confirmOrder(1, { customer: { district_id: '13' } })],
      },
      marketReq,
    );
    expect(res.data.results[0]).toEqual(
      expect.objectContaining({ ok: false, code: 'district_mismatch' }),
    );
    expect(orderCreateCalls(fx.order)).toHaveLength(0);
  });

  it('#8 boshqa marketning product_id si — o‘sha buyurtma RAD etiladi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1),
          confirmOrder(2, { items: [{ product_id: '99', quantity: 1 }] }),
          confirmOrder(3, { items: [{ product_id: '424242', quantity: 1 }] }),
        ],
      },
      marketReq,
    );
    const { results } = res.data;
    expect(results[0].ok).toBe(true);
    expect(results[1]).toEqual(
      expect.objectContaining({ ok: false, code: 'product_foreign' }),
    );
    expect(results[2]).toEqual(
      expect.objectContaining({ ok: false, code: 'product_not_found' }),
    );
    expect(orderCreateCalls(fx.order)).toHaveLength(1);
  });

  it('#11 10 buyurtmali partiyada logistics va catalog find_by_ids BIR MARTADAN', async () => {
    const fx = makeController();
    const orders = Array.from({ length: 10 }, (_, i) =>
      confirmOrder(i + 1, {
        district_id: ['12', '13', '20'][i % 3],
        items: [{ product_id: i % 2 ? '15' : '16', quantity: 1 }],
      }),
    );
    const res = await fx.controller.aiConfirm({ orders }, marketReq);

    expect(res.data.results.every((r) => r.ok)).toBe(true);
    expect(fx.logistics.send).toHaveBeenCalledTimes(1);
    expect(fx.logistics.send.mock.calls[0][0]).toEqual({
      cmd: 'logistics.district.find_by_ids',
    });
    expect([...(fx.logistics.send.mock.calls[0][1].ids ?? [])].sort()).toEqual([
      '12',
      '13',
      '20',
    ]);
    expect(fx.catalog.send).toHaveBeenCalledTimes(1);
    expect(fx.catalog.send.mock.calls[0][0]).toEqual({
      cmd: 'catalog.product.find_by_ids',
    });
    expect([...(fx.catalog.send.mock.calls[0][1].ids ?? [])].sort()).toEqual([
      '15',
      '16',
    ]);
  });

  it('faqat erkin matnli mahsulotlar — catalog umuman chaqirilmaydi', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, {
            items: [
              {
                product_name: 'Yangi mahsulot',
                quantity: 1,
                allow_unlisted_product: true,
              },
            ],
          }),
        ],
      },
      marketReq,
    );
    expect(fx.catalog.send).not.toHaveBeenCalled();
    expect(orderCreateCalls(fx.order)).toHaveLength(1);
  });

  it('#12 3-buyurtma yiqilsa qolgan 9 tasi yaratiladi; har biriga alohida natija', async () => {
    const fx = makeController();
    let nextId = 1;
    fx.order.send.mockImplementation((_pattern, payload) =>
      payload.dto?.customer_id === `c${phoneFor(3)}`
        ? throwError(() => new Error('DB xatosi'))
        : of({ id: String(nextId++) }),
    );
    const orders = Array.from({ length: 10 }, (_, i) => confirmOrder(i + 1));
    const res = await fx.controller.aiConfirm({ orders }, marketReq);
    const { results } = res.data;

    expect(results).toHaveLength(10);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results.filter((r) => r.ok)).toHaveLength(9);
    expect(results[2].ok).toBe(false);
    expect(typeof results[2].code).toBe('string');
    expect(typeof results[2].reason).toBe('string');
    // Xom xato/payload javobga chiqmaydi.
    expect(JSON.stringify(results[2])).not.toContain(phoneFor(3));
  });

  it('parallellik ≤ 3 va bir telefonli buyurtmalar HECH QACHON ustma-ust ketmaydi', async () => {
    const fx = makeController();
    let active = 0;
    let maxActive = 0;
    const activePhones = new Set<string>();
    let sameLaneOverlap = false;

    fx.identity.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'identity.market.find_by_id'
        ? of({ data: { id: payload.id, status: 'active', add_order: true } })
        : defer(() => {
            const phone = payload.dto?.phone_number ?? '';
            if (activePhones.has(phone)) sameLaneOverlap = true;
            activePhones.add(phone);
            active += 1;
            maxActive = Math.max(maxActive, active);
            return timer(5).pipe(map(() => ({ data: { id: `c${phone}` } })));
          }),
    );
    let nextId = 1;
    fx.order.send.mockImplementation((_pattern, payload) =>
      timer(5).pipe(
        map(() => ({ id: String(nextId++) })),
        finalize(() => {
          active -= 1;
          activePhones.delete((payload.dto?.customer_id ?? '').slice(1));
        }),
      ),
    );

    // 4 ta telefon × 3 ta buyurtma (narx har xil — partiya dublikati emas).
    const orders = Array.from({ length: 12 }, (_, i) =>
      confirmOrder(i + 1, {
        customer: { phone_number: phoneFor((i % 4) + 1) },
      }),
    );
    const res = await fx.controller.aiConfirm({ orders }, marketReq);

    expect(res.data.results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(sameLaneOverlap).toBe(false);
  });

  it('#13 order.create keshdan qaytsa (idempotent_replay) → duplicate_recent, mavjud id bilan', async () => {
    const fx = makeController();
    fx.order.send.mockImplementation(() =>
      of({ id: '555', status: 'new', idempotent_replay: true }),
    );
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { draft_id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
        ],
      },
      marketReq,
    );
    expect(res.data.results[0]).toEqual({
      index: 0,
      ok: false,
      code: 'duplicate_recent',
      order_id: '555',
      reason: stringContaining('#555'),
    });
    // Dublikat yangi buyurtma emas — xarajatga bog'lanmaydi.
    expect(sendsOf(fx.ai, 'ai.usage.link_orders')).toHaveLength(0);
  });

  it('#13 dedupe kaliti: request_id = "ai-dedupe:<sha256>", takror yuborishda AYNAN bir xil', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    const [first, second] = orderCreateCalls(fx.order).map(
      ([, payload]) => payload.request_id,
    );
    expect(first).toMatch(/^ai-dedupe:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('POST /orders (create) — request_id QO‘SHILMAYDI (xulq o‘zgarmagan)', async () => {
    const fx = makeController();
    await fx.controller.create(
      { customer_id: '55', market_id: '77' },
      adminReq,
    );
    const payload = orderCreatePayload(fx.order);
    expect(Object.keys(payload).sort()).toEqual(['dto', 'requester']);
  });

  it('partiya ichidagi dublikat → duplicate_in_batch, faqat bittasi yaratiladi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1), confirmOrder(1), confirmOrder(2)] },
      marketReq,
    );
    expect(res.data.results.map((r) => r.code ?? 'ok')).toEqual([
      'ok',
      'duplicate_in_batch',
      'ok',
    ]);
    expect(orderCreateCalls(fx.order)).toHaveLength(2);
  });

  it('tekshiruv RPC’si ishlamasa — HAMMASI validation_unavailable, hech narsa yaratilmaydi', async () => {
    const fx = makeController();
    fx.logistics.send.mockImplementation(() =>
      throwError(() => new Error('logistics down')),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1), confirmOrder(2)] },
      marketReq,
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.results).toEqual([
      expect.objectContaining({
        index: 0,
        ok: false,
        code: 'validation_unavailable',
      }),
      expect.objectContaining({
        index: 1,
        ok: false,
        code: 'validation_unavailable',
      }),
    ]);
    expect(orderCreateCalls(fx.order)).toHaveLength(0);
    expect(sendsOf(fx.identity, 'identity.customer.create')).toHaveLength(0);
  });

  it('catalog javob bermasa (8s) ham validation_unavailable', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const fx = makeController();
    fx.catalog.send.mockImplementation(() => NEVER);
    const pending = fx.controller.aiConfirm(
      { orders: [confirmOrder(1)] },
      marketReq,
    );
    await jest.advanceTimersByTimeAsync(8_000);
    const res = await pending;
    expect(res.data.results[0].code).toBe('validation_unavailable');
    expect(orderCreateCalls(fx.order)).toHaveLength(0);
  });

  describe('operator matni operator_id ga BOG‘LANMAYDI (32fNx0Ci #11)', () => {
    it('MARKET → operator_id null, "sevinch" faqat operator matni', async () => {
      const fx = makeController();
      await fx.controller.aiConfirm(
        { orders: [confirmOrder(1, { operator: 'sevinch' })] },
        marketReq,
      );
      const dto = createdDto(fx.order);
      expect(dto.operator_id).toBeNull();
      expect(dto.operator).toBe('sevinch');
    });

    it('MARKET_OPERATOR → operator_id = token sub (matndan emas)', async () => {
      const fx = makeController();
      await fx.controller.aiConfirm(
        { orders: [confirmOrder(1, { operator: 'sevinch' })] },
        operatorReq,
      );
      const dto = createdDto(fx.order);
      expect(dto.operator_id).toBe('501');
      expect(dto.operator).toBe('sevinch');
      expect(dto.market_id).toBe(MARKET_ID);
    });
  });

  it('link_orders har draft_id uchun BIR MARTA, faqat yaratilganlar bilan', async () => {
    const fx = makeController();
    const draftA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const draftB = 'bbbbbbbb-0000-4000-8000-000000000002';
    let nextId = 1;
    fx.order.send.mockImplementation((_pattern, payload) =>
      payload.dto?.customer_id === `c${phoneFor(4)}`
        ? throwError(() => new Error('yiqildi'))
        : of({ id: String(nextId++) }),
    );
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { draft_id: draftA }),
          confirmOrder(2, { draft_id: draftA }),
          confirmOrder(3, { draft_id: draftB }),
          confirmOrder(4, { draft_id: draftB }),
          confirmOrder(5),
        ],
      },
      marketReq,
    );
    const ids = res.data.results.map((r) => r.order_id);

    const links = sendsOf(fx.ai, 'ai.usage.link_orders');
    expect(links).toHaveLength(2);
    expect(links.map(([, payload]) => payload)).toEqual(
      expect.arrayContaining([
        { draft_id: draftA, order_ids: [ids[0], ids[1]], market_id: MARKET_ID },
        { draft_id: draftB, order_ids: [ids[2]], market_id: MARKET_ID },
      ]),
    );
  });

  it('link_orders xatosi natijaga ta’sir qilmaydi', async () => {
    const fx = makeController();
    fx.ai.send.mockImplementation(() => throwError(() => new Error('ai down')));
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { draft_id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
        ],
      },
      marketReq,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.data.results[0].ok).toBe(true);
  });

  describe('partiya darajasi — xato bo‘lsa HECH NARSA yaratilmaydi', () => {
    it('MARKET: tanadagi market_id e’tiborsiz, token sub', async () => {
      const fx = makeController();
      await fx.controller.aiConfirm(
        { market_id: '999', orders: [confirmOrder(1)] },
        marketReq,
      );
      expect(createdDto(fx.order).market_id).toBe(MARKET_ID);
    });

    it('admin market_id’siz → 400', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, adminReq),
      ).rejects.toThrow('market_id majburiy');
      expect(fx.logistics.send).not.toHaveBeenCalled();
      expect(fx.order.send).not.toHaveBeenCalled();
    });

    it('admin market_id bilan — market_id o‘sha qiymat, operator_id null', async () => {
      const fx = makeController();
      await fx.controller.aiConfirm(
        { market_id: MARKET_ID, orders: [confirmOrder(1)] },
        adminReq,
      );
      const dto = createdDto(fx.order);
      expect(dto.market_id).toBe(MARKET_ID);
      expect(dto.operator_id).toBeNull();
    });

    it('MARKET_OPERATOR marketsiz → 400', async () => {
      const fx = makeController();
      fx.identity.send.mockImplementation(() =>
        of({ data: { market_id: null } }),
      );
      await expect(
        fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, operatorReq),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fx.order.send).not.toHaveBeenCalled();
    });

    it('filial xodimi (MANAGER) filialsiz → 400, hech narsa yaratilmaydi', async () => {
      const fx = makeController();
      fx.branch.send.mockReturnValue(
        of({ data: { branch_id: null, role: 'MANAGER' } }),
      );
      await expect(
        fx.controller.aiConfirm(
          { market_id: MARKET_ID, orders: [confirmOrder(1)] },
          { user: { sub: '9', username: 'mgr', roles: ['manager'] } },
        ),
      ).rejects.toThrow('Filial xodimi hech qaysi filialga biriktirilmagan');
      expect(fx.logistics.send).not.toHaveBeenCalled();
      expect(sendsOf(fx.identity, 'identity.customer.create')).toHaveLength(0);
      expect(fx.order.send).not.toHaveBeenCalled();
    });

    it('MANAGER: filial partiyaga BIR MARTA aniqlanadi va har buyurtmaga qo‘yiladi', async () => {
      const fx = makeController();
      fx.branch.send.mockReturnValue(
        of({ data: { branch_id: '12', role: 'MANAGER' } }),
      );
      await fx.controller.aiConfirm(
        {
          market_id: MARKET_ID,
          orders: [confirmOrder(1), confirmOrder(2), confirmOrder(3)],
        },
        { user: { sub: '9', username: 'mgr', roles: ['manager'] } },
      );
      expect(fx.branch.send).toHaveBeenCalledTimes(1);
      const dtos = orderCreateCalls(fx.order).map(
        ([, payload]) => payload.dto ?? {},
      );
      expect(dtos).toHaveLength(3);
      for (const dto of dtos) {
        expect(dto.branch_id).toBe('12');
        expect(dto.source).toBe('branch');
      }
    });
  });

  it('order.create javob bermasa → timeout_unknown; 75s muddatdan keyin qolganlari not_started', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const fx = makeController();
    fx.order.send.mockImplementation(() => NEVER);
    // Bitta telefon — bitta yo'lak: buyurtmalar ketma-ket, har biri 8s da uziladi.
    const orders = Array.from({ length: 12 }, (_, i) =>
      confirmOrder(i + 1, { customer: { phone_number: phoneFor(1) } }),
    );
    const pending = fx.controller.aiConfirm({ orders }, marketReq);
    await jest.advanceTimersByTimeAsync(120_000);
    const { results } = (await pending).data;

    expect(results).toHaveLength(12);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results[0].code).toBe('timeout_unknown');
    expect(results[11].code).toBe('not_started');
    expect(typeof results[11].reason).toBe('string');
    // Muddatdan keyin yangi yaratish BOSHLANMAYDI.
    expect(orderCreateCalls(fx.order).length).toBeLessThan(12);
  });
});
