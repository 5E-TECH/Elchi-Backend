import 'reflect-metadata';
import {
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import {
  AllExceptionsFilter,
  Where_deliver,
  publicErrorFields,
  type AiDraftConfirmContext,
  type AiDraftPreviewSnapshot,
} from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import type { AiStatusPoller } from './ai/ai-status.poller';
import { aiPhoneDigest } from './ai-order/ai-edited-fields';
import { missingAckChecks, requiredAckChecks } from './ai-order/ai-ack-checks';
import { aiConfirmAckTotal } from './ai-order/ai-ack-metrics';
import {
  AiConfirmRequestDto,
  type AiConfirmOrderDto,
} from './dto/ai-order.swagger.dto';

/**
 * AI ack (ega qarori 2026-11-14) — `POST /orders/ai-confirm`:
 * `district_low_confidence` / `price_check` SAQLANGAN snapshot'da bo'lsa,
 * `ack_checks` siz 409 `CHECKS_NOT_ACKNOWLEDGED`. Barcha ma'lumot soxta.
 */
type Pattern = { cmd: string };
type Payload = Record<string, any>;
type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, Payload]> };
const fake = (): Fake => ({ send: jest.fn() });
const asClient = (f: Fake) => f as unknown as ClientProxy;

const MARKET_ID = '77';
const DRAFT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const DISTRICTS = [
  { id: '12', name: 'Chilonzor', region_id: '1' },
  { id: '13', name: 'Yunusobod', region_id: '1' },
];
const PRODUCTS = [{ id: '15', name: 'Atir', user_id: MARKET_ID }];
const phoneFor = (n: number) => `+99890123456${n}`;

const snapshotFor = (
  n: number,
  checkCodes?: string[],
): AiDraftPreviewSnapshot => ({
  index: n,
  customer_name: `Mijoz ${n}`,
  phone_masked: '+99890*****6' + n,
  phone_sha256: aiPhoneDigest(phoneFor(n)),
  extra_masked: null,
  extra_sha256: null,
  region_id: '1',
  district_id: '12',
  address: null,
  total_price: 150000,
  where_deliver: 'center',
  comment: null,
  operator: null,
  is_replacement: false,
  items: [{ name: 'atir', product_id: '15', quantity: 1 }],
  ...(checkCodes ? { check_codes: checkCodes } : {}),
});

const order = (
  n: number,
  over: Partial<AiConfirmOrderDto> = {},
): AiConfirmOrderDto => ({
  customer: {
    name: `Mijoz ${n}`,
    phone_number: phoneFor(n),
    district_id: '12',
  },
  district_id: '12',
  items: [{ product_id: '15', quantity: 1 }],
  total_price: 150000,
  where_deliver: Where_deliver.CENTER,
  draft_id: DRAFT,
  ai_item_index: n,
  ...over,
});

interface SetupOpts {
  contextError?: boolean;
  /** `AI_ACK_CHECKS_ENFORCE` (sukut shu spec'da — `on`). */
  enforce?: 'on' | 'off';
  /** confirm_context javobidagi draft'ga qo'shimcha (S1: holat, vaqt). */
  ctx?: Partial<AiDraftConfirmContext>;
  /** confirm_context javobi butunlay (masalan `{ drafts: [] }`). */
  contexts?: unknown;
  /** B1: TEZ mijoz (`AI_FAST`) — eski `AI` mijozda confirm_context osiladi. */
  fast?: boolean;
}

function setup(
  previews: AiDraftPreviewSnapshot[] | null,
  opts: SetupOpts = {},
) {
  const orderC = fake();
  const identity = fake();
  const logistics = fake();
  const ai = fake();
  const aiFast = fake();
  const catalog = fake();
  logistics.send.mockImplementation((_p, payload) =>
    of({ data: DISTRICTS.filter((d) => (payload.ids ?? []).includes(d.id)) }),
  );
  catalog.send.mockImplementation((_p, payload) =>
    of({ data: PRODUCTS.filter((p) => (payload.ids ?? []).includes(p.id)) }),
  );
  identity.send.mockImplementation((pattern, payload) => {
    if (pattern.cmd === 'identity.customer.create') {
      return of({ data: { id: `c${payload.dto?.phone_number}` } });
    }
    if (pattern.cmd === 'identity.market.find_by_id') {
      return of({
        data: { id: payload.id, status: 'active', add_order: true },
      });
    }
    return of({ data: null });
  });
  let next = 7000;
  orderC.send.mockImplementation(() => of({ data: { id: String(next++) } }));
  const draftsReply = (pattern: Pattern): Observable<unknown> => {
    if (pattern.cmd === 'ai.draft.confirm_context') {
      return opts.contextError
        ? throwError(() => new Error('ai down'))
        : of(
            opts.contexts ?? {
              drafts: [
                {
                  draft_id: DRAFT,
                  model: 'claude-sonnet-5',
                  prompt_version: '2026-11-14.1',
                  preview_count: 3,
                  cost_usd: 0.1,
                  cost_uzs: 1280,
                  previews,
                  created_at: new Date().toISOString(),
                  snapshot_state: previews ? 'present' : 'pending',
                  ...opts.ctx,
                },
              ],
            },
          );
    }
    return of({ updated: 1 });
  };
  if (opts.fast) {
    // B1: umumiy `ai_queue` Claude chaqiruvlari bilan band — draft/usage
    // naqshlari u yerda HECH QACHON javob olmaydi (3 s timeout → 503 bo'lardi).
    ai.send.mockImplementation((pattern) =>
      pattern.cmd.startsWith('ai.draft.') ||
      pattern.cmd === 'ai.usage.link_orders'
        ? NEVER
        : of({ ok: true }),
    );
    aiFast.send.mockImplementation(draftsReply);
  } else {
    ai.send.mockImplementation(draftsReply);
  }
  const controller = new OrderGatewayController(
    asClient(orderC),
    asClient(identity),
    asClient(logistics),
    asClient(fake()),
    asClient(fake()),
    asClient(ai),
    asClient(catalog),
    {
      get: jest.fn((key: string) =>
        key === 'AI_ACK_CHECKS_ENFORCE' ? (opts.enforce ?? 'on') : undefined,
      ),
    } as unknown as ConfigService,
    { getState: jest.fn(() => 'enabled') } as unknown as AiStatusPoller,
    undefined,
    undefined,
    undefined,
    opts.fast ? asClient(aiFast) : undefined,
  );
  const creates = () =>
    orderC.send.mock.calls.filter(([p]) => p.cmd === 'order.create');
  return { controller, creates, ai, aiFast };
}

const marketReq = {
  user: { sub: MARKET_ID, username: 'm', roles: ['market'] },
};

async function conflictOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as Record<string, unknown>;
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('requiredAckChecks / missingAckChecks', () => {
  it('faqat bloklovchi kodlar; yumshoqlari ack talab qilmaydi', () => {
    const p = snapshotFor(0, [
      'qty_check',
      'price_check',
      'phone_is_market',
      'district_low_confidence',
      'same_phone_multi',
      'duplicate_items',
    ]);
    expect(requiredAckChecks(p, [])).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
  });

  it('tahrir istisnosi: district_id → tuman, total_price → summa', () => {
    const p = snapshotFor(0, ['district_low_confidence', 'price_check']);
    expect(requiredAckChecks(p, ['district_id'])).toEqual(['price_check']);
    expect(requiredAckChecks(p, ['total_price'])).toEqual([
      'district_low_confidence',
    ]);
    // Viloyat/manzil tahriri tuman tekshiruvini olib tashlamaydi.
    expect(requiredAckChecks(p, ['region_id', 'address'])).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
  });

  it('eski snapshot (check_codes yo‘q) yoki snapshot yo‘q — talab yo‘q', () => {
    expect(requiredAckChecks(snapshotFor(0), [])).toEqual([]);
    expect(requiredAckChecks(null, null)).toEqual([]);
  });

  it('missing — talab tartibida, matn bo‘lmagan ack e’tiborsiz', () => {
    expect(
      missingAckChecks(
        ['district_low_confidence', 'price_check'],
        ['price_check', 5, 'qty_check'],
      ),
    ).toEqual(['district_low_confidence']);
    expect(missingAckChecks([], undefined)).toEqual([]);
  });
});

describe('ai-confirm — ack_checks (409 CHECKS_NOT_ACKNOWLEDGED)', () => {
  it('bloklovchi kod tasdiqlanmagan → 409, hech narsa yaratilmaydi', async () => {
    const fx = setup([
      snapshotFor(0, ['district_low_confidence', 'qty_check']),
      snapshotFor(1, ['price_check']),
      snapshotFor(2, ['phone_is_market']),
    ]);
    const body = await conflictOf(
      fx.controller.aiConfirm(
        {
          orders: [
            order(0),
            order(1, { ack_checks: ['district_low_confidence'] }),
            order(2),
          ],
        },
        marketReq,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'CHECKS_NOT_ACKNOWLEDGED',
      missing: ['district_low_confidence', 'price_check'],
      orders: [
        { index: 0, missing: ['district_low_confidence'] },
        { index: 1, missing: ['price_check'] },
      ],
    });
    expect(fx.creates()).toHaveLength(0);
  });

  it('409 tanasi gateway filtridan `code`, `missing`, `orders` bilan chiqadi', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])]);
    const error = await fx.controller
      .aiConfirm({ orders: [order(0)] }, marketReq)
      .catch((e: unknown) => e as ConflictException);
    expect(publicErrorFields(error.getResponse())).toEqual({
      code: 'CHECKS_NOT_ACKNOWLEDGED',
      missing: ['price_check'],
      orders: [{ index: 0, missing: ['price_check'] }],
    });

    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new AllExceptionsFilter().catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({
      statusCode: 409,
      code: 'CHECKS_NOT_ACKNOWLEDGED',
      missing: ['price_check'],
      orders: [{ index: 0, missing: ['price_check'] }],
    });
  });

  it('hammasi tasdiqlangan → yaratiladi (ortiqcha/yumshoq kodlar zarar qilmaydi)', async () => {
    const fx = setup([
      snapshotFor(0, ['district_low_confidence', 'price_check', 'qty_check']),
      snapshotFor(1, ['same_phone_multi']),
    ]);
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          order(0, {
            ack_checks: ['price_check', 'district_low_confidence'],
          }),
          order(1, { ack_checks: ['qty_check'] }),
        ],
      },
      marketReq,
    );
    expect(res.data.results.map((r) => r.ok)).toEqual([true, true]);
    expect(fx.creates()).toHaveLength(2);
    // ack_checks order-service'ga uzatilmaydi.
    expect(fx.creates()[0][1]).not.toHaveProperty('ack_checks');
  });

  it('operator tuman va summani o‘zi tuzatgan → ack shart emas', async () => {
    const fx = setup([
      snapshotFor(0, ['district_low_confidence', 'price_check']),
    ]);
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          order(0, {
            district_id: '13',
            customer: {
              name: 'Mijoz 0',
              phone_number: phoneFor(0),
              district_id: '13',
            },
            total_price: 15000,
          }),
        ],
      },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
  });

  it('faqat summa tuzatilgan → tuman tekshiruvi hali talab qilinadi', async () => {
    const fx = setup([
      snapshotFor(0, ['district_low_confidence', 'price_check']),
    ]);
    const body = await conflictOf(
      fx.controller.aiConfirm(
        { orders: [order(0, { total_price: 15000 })] },
        marketReq,
      ),
    );
    expect(body.missing).toEqual(['district_low_confidence']);
  });

  it('eski draft (check_codes yo‘q) — ack so‘ralmaydi', async () => {
    const fx = setup([snapshotFor(0)]);
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
  });

  it('mijoz yuborgan `checks` hisobga olinmaydi — faqat saqlangan snapshot', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])]);
    const body = await conflictOf(
      fx.controller.aiConfirm(
        {
          orders: [{ ...order(0), checks: [] } as unknown as AiConfirmOrderDto],
        },
        marketReq,
      ),
    );
    expect(body.missing).toEqual(['price_check']);
  });

  it('snapshot retention’da tozalangan (purged) — fail-open, checks_unverified', async () => {
    const noPreview = setup(null, { ctx: { snapshot_state: 'purged' } });
    const r1 = await noPreview.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(r1.data.results[0].ok).toBe(true);
    expect(noPreview.creates()[0][1].ai_audit).toMatchObject({
      checks_unverified: true,
    });
  });

  it('ai-service ishlamadi — FAIL-CLOSED 503 AI_CHECKS_UNAVAILABLE (gateway filtri orqali ham)', async () => {
    const down = setup([snapshotFor(0, ['price_check'])], {
      contextError: true,
    });
    const err = await down.controller
      .aiConfirm({ orders: [order(0)] }, marketReq)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new AllExceptionsFilter().catch(err, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(json.mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: 'AI_CHECKS_UNAVAILABLE',
      retryable: true,
      retry_after_seconds: 5,
    });
    expect(down.creates()).toHaveLength(0);
  });

  it('DTO: ack_checks — kod satrlari massivi, ≤10', async () => {
    const check = async (ack: unknown) =>
      JSON.stringify(
        await validate(
          plainToInstance(AiConfirmRequestDto, {
            orders: [{ ...order(0), ack_checks: ack }],
          }),
          { whitelist: true, forbidNonWhitelisted: true },
        ),
      );
    expect(await check(['price_check', 'district_low_confidence'])).toBe('[]');
    expect(await check('price_check')).toContain('ack_checks');
    expect(await check(['Price Check'])).toContain('ack_checks');
    expect(
      await check(Array.from({ length: 11 }, () => 'qty_check')),
    ).toContain('ack_checks');
  });
});

/** Rad etilgan va'dani HttpException sifatida qaytaradi. */
async function rejectionOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

/** Gateway filtri orqali: holat, tana va sarlavhalar. */
function throughFilter(error: unknown) {
  const headers = new Map<string, string>();
  const json = jest.fn();
  const response = {
    status: jest.fn(() => ({ json })),
    setHeader: jest.fn((k: string, v: string) =>
      headers.set(k.toLowerCase(), v),
    ),
    getHeader: (k: string) => headers.get(k.toLowerCase()),
  };
  new AllExceptionsFilter().catch(error, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as never);
  const calls = response.status.mock.calls as unknown as [number][];
  return {
    status: calls[0]?.[0],
    body: json.mock.calls[0]?.[0] as Record<string, unknown>,
    headers,
  };
}

const ackCount = async (outcome: string, enforced: 'on' | 'off') => {
  const metric = await aiConfirmAckTotal.get();
  return (
    metric.values.find(
      (v) => v.labels.outcome === outcome && v.labels.enforced === enforced,
    )?.value ?? 0
  );
};

const warns = () =>
  (Logger.prototype.warn as unknown as jest.Mock).mock.calls.map((c) =>
    String(c[0]),
  );

describe('AI ack round-3 — B1 tez navbat (AI_FAST)', () => {
  it('confirm_context / link_orders TEZ mijoz orqali; eski AI mijozi band bo‘lsa ham yaratiladi', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])], { fast: true });
    const startedAt = Date.now();
    const res = await fx.controller.aiConfirm(
      { orders: [order(0, { ack_checks: ['price_check'] })] },
      marketReq,
    );
    // Eski mijoz ishlatilganda 3 s timeout → 503 bo'lardi.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(res.data.results[0].ok).toBe(true);
    const cmds = (f: Fake) => f.send.mock.calls.map(([p]) => p.cmd);
    expect(cmds(fx.aiFast)).toEqual(
      expect.arrayContaining([
        'ai.draft.confirm_context',
        'ai.usage.link_orders',
      ]),
    );
    expect(cmds(fx.ai)).not.toContain('ai.draft.confirm_context');
    expect(cmds(fx.ai)).not.toContain('ai.usage.link_orders');
  });

  it('TEZ mijoz yo‘q (eski spec / konfiguratsiya) — umumiy AI mijozi', async () => {
    const fx = setup([snapshotFor(0)]);
    await fx.controller.aiConfirm({ orders: [order(0)] }, marketReq);
    expect(fx.ai.send.mock.calls.map(([p]) => p.cmd)).toContain(
      'ai.draft.confirm_context',
    );
  });
});

describe('AI ack round-3 — B2/S1/S5 darvozalar', () => {
  it('noma’lum draft_id → 400 AI_DRAFT_NOT_FOUND { indexes }', async () => {
    const fx = setup(null, { contexts: { drafts: [] } });
    const err = await rejectionOf(
      fx.controller.aiConfirm({ orders: [order(0), order(1)] }, marketReq),
    );
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      code: 'AI_DRAFT_NOT_FOUND',
      indexes: [0, 1],
    });
    expect(err.getResponse()).not.toHaveProperty('orders');
    expect(fx.creates()).toHaveLength(0);
  });

  it('B2: snapshot bor, lekin ai_item_index=29 yo‘q → 400 AI_DRAFT_ITEM_NOT_FOUND { indexes }', async () => {
    const fx = setup([
      snapshotFor(0, ['price_check']),
      snapshotFor(1, []),
      snapshotFor(2, []),
    ]);
    const err = await rejectionOf(
      fx.controller.aiConfirm(
        {
          orders: [
            order(1, { ack_checks: [] }),
            order(3, { ai_item_index: 29 }),
          ],
        },
        marketReq,
      ),
    );
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      code: 'AI_DRAFT_ITEM_NOT_FOUND',
      indexes: [1],
    });
    expect(fx.creates()).toHaveLength(0);
    const { body } = throughFilter(err);
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'AI_DRAFT_ITEM_NOT_FOUND',
      indexes: [1],
    });
  });

  it('B2: eski snapshot (check_codes yo‘q) — mos indeks bo‘lsa fail-open (WARN fail_open_legacy)', async () => {
    const before = await ackCount('fail_open_legacy', 'on');
    const fx = setup([snapshotFor(0)]);
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
    expect(await ackCount('fail_open_legacy', 'on')).toBe(before + 1);
    expect(warns().some((w) => w.includes('ai_ack fail_open_legacy'))).toBe(
      true,
    );
  });

  it('S1: snapshot hali yo‘q, draft YOSH (pending) → 503 AI_CHECKS_UNAVAILABLE + Retry-After', async () => {
    const fx = setup(null, {
      ctx: {
        snapshot_state: 'pending',
        created_at: new Date(Date.now() - 20_000).toISOString(),
      },
    });
    const err = await rejectionOf(
      fx.controller.aiConfirm({ orders: [order(0)] }, marketReq),
    );
    expect(err.getStatus()).toBe(503);
    expect(fx.creates()).toHaveLength(0);
    const { status, body, headers } = throughFilter(err);
    expect(status).toBe(503);
    expect(body).toMatchObject({
      code: 'AI_CHECKS_UNAVAILABLE',
      retryable: true,
      retry_after_seconds: 5,
    });
    expect(headers.get('retry-after')).toBe('5');
  });

  it('S1: snapshot yo‘q, draft ESKI (> 2 daqiqa) → fail-open, WARN fail_open_snapshot_missing', async () => {
    const before = await ackCount('fail_open_snapshot_missing', 'on');
    const fx = setup(null, {
      ctx: {
        snapshot_state: 'pending',
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    });
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
    expect(fx.creates()[0][1].ai_audit).toMatchObject({
      checks_unverified: true,
    });
    expect(await ackCount('fail_open_snapshot_missing', 'on')).toBe(before + 1);
  });

  it('S1: eski ai-service (snapshot_state/created_at yo‘q) — fail-open', async () => {
    const fx = setup(null, {
      ctx: { snapshot_state: undefined, created_at: undefined },
    });
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
  });

  it('S5/S6: AI_DRAFT_REQUIRED filtr orqali — `indexes`, `orders` emas', async () => {
    const fx = setup([snapshotFor(0)]);
    const err = await rejectionOf(
      fx.controller.aiConfirm(
        { orders: [order(0), order(1, { draft_id: undefined })] },
        marketReq,
      ),
    );
    const { status, body } = throughFilter(err);
    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'AI_DRAFT_REQUIRED',
      indexes: [1],
    });
    expect(body).not.toHaveProperty('orders');
  });

  it('S4: 409 matni — «Baribir yaratish»', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])]);
    const body = await conflictOf(
      fx.controller.aiConfirm({ orders: [order(0)] }, marketReq),
    );
    expect(body.message).toBe(
      'AI ogohlantirishlari tasdiqlanmagan: tuman yoki summani tekshirib, «Baribir yaratish»ni bosing',
    );
  });

  it('S8: idempotent takror ham ack darvozasidan o‘tadi (ack’siz — 409, order-service chaqirilmaydi)', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])]);
    const first = await fx.controller.aiConfirm(
      { orders: [order(0, { ack_checks: ['price_check'] })] },
      marketReq,
    );
    expect(first.data.results[0].ok).toBe(true);
    const createsBefore = fx.creates().length;
    await conflictOf(
      fx.controller.aiConfirm({ orders: [order(0)] }, marketReq),
    );
    expect(fx.creates()).toHaveLength(createsBefore);
  });
});

describe('AI ack round-3 — S2 AI_ACK_CHECKS_ENFORCE=off (log-only)', () => {
  it('409 o‘rniga — yaratiladi, WARN would_409, hisoblagich enforced=off', async () => {
    const before = await ackCount('checks_not_acknowledged', 'off');
    const fx = setup([snapshotFor(0, ['price_check'])], { enforce: 'off' });
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
    expect(fx.creates()).toHaveLength(1);
    expect(
      warns().some(
        (w) =>
          w.includes('ai_ack would_409') &&
          w.includes('CHECKS_NOT_ACKNOWLEDGED') &&
          w.includes('orders=1'),
      ),
    ).toBe(true);
    expect(await ackCount('checks_not_acknowledged', 'off')).toBe(before + 1);
  });

  it('AI_DRAFT_REQUIRED / NOT_FOUND / ITEM_NOT_FOUND o‘rniga — yaratiladi, WARN would_400', async () => {
    const required = setup([snapshotFor(0)], { enforce: 'off' });
    const r1 = await required.controller.aiConfirm(
      {
        orders: [order(0, { draft_id: undefined, ai_item_index: undefined })],
      },
      marketReq,
    );
    expect(r1.data.results[0].ok).toBe(true);

    const notFound = setup(null, {
      enforce: 'off',
      contexts: { drafts: [] },
    });
    const r2 = await notFound.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(r2.data.results[0].ok).toBe(true);

    const item = setup([snapshotFor(0)], { enforce: 'off' });
    const r3 = await item.controller.aiConfirm(
      { orders: [order(5)] },
      marketReq,
    );
    expect(r3.data.results[0].ok).toBe(true);
    const w = warns().filter((x) => x.includes('ai_ack would_400'));
    expect(w.some((x) => x.includes('AI_DRAFT_REQUIRED'))).toBe(true);
    expect(w.some((x) => x.includes('AI_DRAFT_NOT_FOUND'))).toBe(true);
    expect(w.some((x) => x.includes('AI_DRAFT_ITEM_NOT_FOUND'))).toBe(true);
  });

  it('503 o‘rniga (ai-service yo‘q / yosh snapshot) — yaratiladi, WARN would_503, audit checks_unverified', async () => {
    const down = setup([snapshotFor(0, ['price_check'])], {
      enforce: 'off',
      contextError: true,
    });
    const r1 = await down.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(r1.data.results[0].ok).toBe(true);
    expect(down.creates()[0][1].ai_audit).toMatchObject({
      ai_draft_verified: false,
      checks_unverified: true,
    });
    const pending = setup(null, { enforce: 'off' });
    const r2 = await pending.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(r2.data.results[0].ok).toBe(true);
    expect(
      warns().filter(
        (x) =>
          x.includes('ai_ack would_503') && x.includes('AI_CHECKS_UNAVAILABLE'),
      ),
    ).toHaveLength(2);
  });

  it('majburiy rejimda WARN rejected_409', async () => {
    const fx = setup([snapshotFor(0, ['price_check'])]);
    await conflictOf(
      fx.controller.aiConfirm({ orders: [order(0)] }, marketReq),
    );
    expect(warns().some((w) => w.includes('ai_ack rejected_409'))).toBe(true);
  });
});
