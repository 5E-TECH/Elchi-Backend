import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError, type Observable } from 'rxjs';
import { Where_deliver, type AiDraftPreviewSnapshot } from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import type { AiStatusPoller } from './ai/ai-status.poller';
import { aiPhoneDigest } from './ai-order/ai-edited-fields';
import {
  AiConfirmRequestDto,
  type AiConfirmOrderDto,
} from './dto/ai-order.swagger.dto';

/**
 * vncdmXOy (AI audit izi) va Cp2v3ZJ7 (barqaror idempotency kaliti) —
 * gateway `POST /orders/ai-confirm` va `GET /orders/:id/ai-trace`.
 * Real Anthropic CHAQIRILMAYDI — barcha RMQ mijozlari soxta.
 */
type Pattern = { cmd: string };
type Payload = Record<string, any>;
type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, Payload]> };
const fake = (): Fake => ({ send: jest.fn() });
const asClient = (f: Fake) => f as unknown as ClientProxy;

const MARKET_ID = '77';
const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000001';
const DISTRICTS = [
  { id: '12', name: 'Chilonzor', region_id: '1' },
  { id: '13', name: 'Yunusobod', region_id: '1' },
];
const PRODUCTS = [{ id: '15', name: 'Atir', user_id: MARKET_ID }];
const phoneFor = (n: number) => `+998901${String(n).padStart(6, '0')}`;

const snapshotFor = (n: number): AiDraftPreviewSnapshot => ({
  index: n,
  customer_name: `Mijoz ${n}`,
  phone_masked: '+99890*****00',
  phone_sha256: aiPhoneDigest(phoneFor(n)),
  extra_masked: null,
  extra_sha256: null,
  region_id: '1',
  district_id: '12',
  address: null,
  total_price: 100000 + n,
  where_deliver: 'center',
  comment: null,
  operator: null,
  is_replacement: false,
  items: [{ name: 'atir', product_id: '15', quantity: 1 }],
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
  total_price: 100000 + n,
  where_deliver: Where_deliver.CENTER,
  draft_id: DRAFT,
  ai_item_index: n,
  ...over,
});

function setup(
  opts: {
    contexts?: unknown;
    contextError?: boolean;
    trace?: unknown;
    /** NFiXfmq6: market yozuvidagi `ai_price_per_order` (yo'q — global). */
    marketAiPrice?: number | null;
  } = {},
) {
  const orderC = fake();
  const identity = fake();
  const logistics = fake();
  const ai = fake();
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
        data: {
          id: payload.id,
          status: 'active',
          add_order: true,
          ...(opts.marketAiPrice !== undefined
            ? { ai_price_per_order: opts.marketAiPrice }
            : {}),
        },
      });
    }
    return of({ data: null });
  });
  let next = 5000;
  orderC.send.mockImplementation(() => of({ data: { id: String(next++) } }));
  ai.send.mockImplementation((pattern) => {
    if (pattern.cmd === 'ai.draft.confirm_context') {
      return opts.contextError
        ? throwError(() => new Error('ai down'))
        : of(
            opts.contexts ?? {
              drafts: [
                {
                  draft_id: DRAFT,
                  model: 'claude-sonnet-5',
                  prompt_version: '2026-09-27.1',
                  preview_count: 10,
                  cost_usd: 0.1,
                  cost_uzs: 1280,
                  previews: Array.from({ length: 10 }, (_, i) =>
                    snapshotFor(i),
                  ),
                },
              ],
            },
          );
    }
    if (pattern.cmd === 'ai.draft.trace_by_order') {
      return of(opts.trace ?? null);
    }
    return of({ updated: 1 });
  });
  const controller = new OrderGatewayController(
    asClient(orderC),
    asClient(identity),
    asClient(logistics),
    asClient(fake()),
    asClient(fake()),
    asClient(ai),
    asClient(catalog),
    { get: jest.fn(() => undefined) } as unknown as ConfigService,
    { getState: jest.fn(() => 'enabled') } as unknown as AiStatusPoller,
  );
  const creates = () =>
    orderC.send.mock.calls.filter(([p]) => p.cmd === 'order.create');
  return { controller, orderC, ai, creates };
}

const marketReq = {
  user: { sub: MARKET_ID, username: 'm', roles: ['market'] },
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ai-confirm — AI audit metadata (vncdmXOy)', () => {
  it('TC1/TC9: 10 ta buyurtma bitta draft’dan → har order.create da ai_audit (ai:true, bir xil ai_draft_id)', async () => {
    const fx = setup();
    const res = await fx.controller.aiConfirm(
      { orders: Array.from({ length: 10 }, (_, i) => order(i)) },
      marketReq,
    );
    expect(res.data.results.every((r) => r.ok)).toBe(true);
    const audits = fx.creates().map(([, p]) => p.ai_audit);
    expect(audits).toHaveLength(10);
    for (const [i, audit] of audits.entries()) {
      expect(audit).toMatchObject({
        ai: true,
        ai_draft_id: DRAFT,
        ai_item_index: i,
        ai_draft_verified: true,
        model: 'claude-sonnet-5',
        prompt_version: '2026-09-27.1',
        ai_draft_cost_uzs: 1280,
        ai_cost_uzs: 128,
      });
    }
    // Kontekst partiyaga BITTA RPC.
    expect(
      fx.ai.send.mock.calls.filter(
        ([p]) => p.cmd === 'ai.draft.confirm_context',
      ),
    ).toHaveLength(1);
  });

  it('TC5: operator hech narsa o‘zgartirmasa edited_fields = []', async () => {
    const fx = setup();
    await fx.controller.aiConfirm({ orders: [order(0)] }, marketReq);
    expect(fx.creates()[0][1].ai_audit.edited_fields).toEqual([]);
  });

  it('TC4: operator tumanni o‘zgartirsa edited_fields ichida district_id (narx ham)', async () => {
    const fx = setup();
    await fx.controller.aiConfirm(
      {
        orders: [
          order(0, {
            district_id: '13',
            customer: {
              name: 'Mijoz 0',
              phone_number: phoneFor(0),
              district_id: '13',
            },
            total_price: 99000,
          }),
        ],
      },
      marketReq,
    );
    expect(fx.creates()[0][1].ai_audit.edited_fields).toEqual([
      'district_id',
      'total_price',
    ]);
  });

  it('TC6: mijoz edited_fields yubora olmaydi (DTO 400) va server o‘zi hisoblaydi', async () => {
    const dto = plainToInstance(AiConfirmRequestDto, {
      orders: [{ ...order(0), edited_fields: [] }],
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(JSON.stringify(errors)).toContain('edited_fields');

    // Validatsiyadan o'tkazilmagan obyekt ham (ichki chaqiruvchi) e'tiborsiz.
    const fx = setup();
    await fx.controller.aiConfirm(
      {
        orders: [
          {
            ...order(0, { total_price: 1 }),
            edited_fields: [],
          } as AiConfirmOrderDto,
        ],
      },
      marketReq,
    );
    expect(fx.creates()[0][1].ai_audit.edited_fields).toEqual(['total_price']);
  });

  it('ai_item_index DTO chegarasi (0..29)', async () => {
    const bad = plainToInstance(AiConfirmRequestDto, {
      orders: [{ ...order(0), ai_item_index: 30 }],
    });
    expect(
      JSON.stringify(
        await validate(bad, { whitelist: true, forbidNonWhitelisted: true }),
      ),
    ).toContain('ai_item_index');
  });

  it('ai-service ishlamasa ham buyurtma yaratiladi (ai_draft_verified:false, edited_fields:null)', async () => {
    const fx = setup({ contextError: true });
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].ok).toBe(true);
    expect(fx.creates()[0][1].ai_audit).toMatchObject({
      ai: true,
      ai_draft_id: DRAFT,
      ai_draft_verified: false,
      edited_fields: null,
      model: null,
    });
  });

  it('TC2: draft_id’siz buyurtma — ai_audit YUBORILMAYDI', async () => {
    const fx = setup();
    await fx.controller.aiConfirm(
      { orders: [order(0, { draft_id: undefined, ai_item_index: undefined })] },
      marketReq,
    );
    expect(fx.creates()[0][1]).not.toHaveProperty('ai_audit');
    expect(fx.creates()[0][1].request_id).toMatch(/^ai-dedupe:[0-9a-f]{64}$/);
  });

  it('link_orders: draft ↔ buyurtma items (edited_fields bilan) va confirmed_by', async () => {
    const fx = setup();
    const res = await fx.controller.aiConfirm(
      { orders: [order(0), order(1, { total_price: 5 })] },
      marketReq,
    );
    const link = fx.ai.send.mock.calls.find(
      ([p]) => p.cmd === 'ai.usage.link_orders',
    )!;
    expect(link[1]).toEqual({
      draft_id: DRAFT,
      order_ids: [res.data.results[0].order_id, res.data.results[1].order_id],
      market_id: MARKET_ID,
      items: [
        {
          item_index: 0,
          order_id: res.data.results[0].order_id,
          edited_fields: [],
          // J3hEDtFN #4: hech narsa o'zgarmagan — tuzatish yo'q.
          field_corrections: null,
        },
        {
          item_index: 1,
          order_id: res.data.results[1].order_id,
          edited_fields: ['total_price'],
          // J3hEDtFN #4: AI taklifi (100001) va operator qiymati (5).
          field_corrections: { total_price: { ai: 100001, final: 5 } },
        },
      ],
      confirmed_by: MARKET_ID,
      // NFiXfmq6: market yozuvida narx yo'q — null (global narx).
      ai_price_per_order: null,
    });
  });
});

describe('ai-confirm — barqaror idempotency kaliti (Cp2v3ZJ7)', () => {
  it('TC1/TC10: request_id = ai:<market>:<draft>:<idx> — qayta yuborishda (sahifa yangilansa ham) AYNAN bir xil', async () => {
    const fx = setup();
    await fx.controller.aiConfirm({ orders: [order(3)] }, marketReq);
    await fx.controller.aiConfirm({ orders: [order(3)] }, marketReq);
    const [a, b] = fx.creates().map(([, p]) => p);
    expect(a.request_id).toBe(`ai:${MARKET_ID}:${DRAFT}:3`);
    expect(b.request_id).toBe(a.request_id);
    // 2-qatlam: mazmun imzosi ham yuboriladi.
    expect(a.ai_signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TC2: takror javob (idempotent_replay) → ok:true, idempotent_replay:true, birinchi order_id; xarajatga qayta bog‘lanmaydi', async () => {
    const fx = setup();
    fx.orderC.send.mockImplementation(() =>
      of({ data: { id: '4242' }, idempotent_replay: true }),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0]).toEqual({
      index: 0,
      ok: true,
      order_id: '4242',
      idempotent_replay: true,
    });
    expect(
      fx.ai.send.mock.calls.filter(([p]) => p.cmd === 'ai.usage.link_orders'),
    ).toHaveLength(0);
  });

  it('TC3: bir xil draft+index bilan ikki marta chaqiruv → pul (narx qaydi) FAQAT BIR marta: link_orders bitta, market narxi bilan', async () => {
    const fx = setup({ marketAiPrice: 450 });
    // order-service `executeIdempotent` emulyatsiyasi: request_id → bitta buyurtma.
    const byKey = new Map<string, string>();
    let next = 7000;
    fx.orderC.send.mockImplementation((_p, payload) => {
      const key = String(payload.request_id);
      const existing = byKey.get(key);
      if (existing) {
        return of({ data: { id: existing }, idempotent_replay: true });
      }
      const id = String(next++);
      byKey.set(key, id);
      return of({ data: { id } });
    });

    // Sahifa yangilanib (yoki tugma qayta bosilib) ayni draft+index qayta yuboriladi.
    const first = await fx.controller.aiConfirm(
      { orders: [order(3)] },
      marketReq,
    );
    const second = await fx.controller.aiConfirm(
      { orders: [order(3)] },
      marketReq,
    );
    expect(first.data.results[0]).toMatchObject({
      ok: true,
      order_id: '7000',
      idempotent_replay: false,
    });
    expect(second.data.results[0]).toMatchObject({
      ok: true,
      order_id: '7000',
      idempotent_replay: true,
    });
    expect(byKey.size).toBe(1);

    // Narx (pul) qaydi faqat YANGI buyurtma uchun — bitta link_orders.
    // ai-service tomonda `order_id` UNIQUE + ON CONFLICT DO NOTHING
    // (ai-draft.pg.spec "narx BIR MARTA qayd qilinadi") ikkinchi qatlam.
    const links = fx.ai.send.mock.calls.filter(
      ([p]) => p.cmd === 'ai.usage.link_orders',
    );
    expect(links).toHaveLength(1);
    expect(links[0][1]).toEqual(
      expect.objectContaining({
        draft_id: DRAFT,
        order_ids: ['7000'],
        items: [expect.objectContaining({ item_index: 3, order_id: '7000' })],
        ai_price_per_order: 450,
      }),
    );
  });

  it('yangi buyurtma → idempotent_replay:false', async () => {
    const fx = setup();
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0]).toMatchObject({
      ok: true,
      idempotent_replay: false,
    });
  });

  it('TC8: boshqa draft’dan ayni mazmun (order-service 409 duplicate_recent) → ogohlantirish + mavjud order_id', async () => {
    const fx = setup();
    fx.orderC.send.mockImplementation(() =>
      throwError(() => ({
        statusCode: 409,
        code: 'duplicate_recent',
        order_id: '777',
        message: 'AI duplicate_recent',
      })),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0]).toMatchObject({
      index: 0,
      ok: false,
      code: 'duplicate_recent',
      order_id: '777',
    });
    expect(res.data.results[0].reason).toContain('#777');
  });

  it('TC4: 10 ta buyurtmadan 3 tasi yiqilsa → 7 ok + 3 error (hammasi yiqilmaydi)', async () => {
    const fx = setup();
    let n = 0;
    fx.orderC.send.mockImplementation((_p, payload) => {
      const idx = Number(String(payload.request_id).split(':').pop());
      return [2, 5, 8].includes(idx)
        ? throwError(() => ({ statusCode: 400, message: 'yiqildi' }))
        : of({ data: { id: String(6000 + n++) } });
    });
    const res = await fx.controller.aiConfirm(
      { orders: Array.from({ length: 10 }, (_, i) => order(i)) },
      marketReq,
    );
    expect(res.data.results.filter((r) => r.ok)).toHaveLength(7);
    expect(res.data.results.filter((r) => !r.ok).map((r) => r.index)).toEqual([
      2, 5, 8,
    ]);
  });

  it('TC6: parallel (in_progress) → duplicate_in_progress', async () => {
    const fx = setup();
    fx.orderC.send.mockImplementation(() =>
      throwError(() => ({
        statusCode: 409,
        message: `Idempotency in_progress for order.create:ai:${MARKET_ID}:${DRAFT}:0`,
      })),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(res.data.results[0].code).toBe('duplicate_in_progress');
  });
});

describe('GET /orders/:id/ai-trace (vncdmXOy TC7/TC8)', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderGatewayController.prototype,
    'aiTrace',
  )?.value as object;

  it('TC7: faqat SUPERADMIN/ADMIN — boshqa rollar 403', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      'superadmin',
      'admin',
    ]);
    const guard = new RolesGuard(new Reflector());
    const ctxFor = (roles: string[]) =>
      ({
        getHandler: () => handler,
        getClass: () => OrderGatewayController,
        switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctxFor(['admin']))).toBe(true);
    expect(guard.canActivate(ctxFor(['superadmin']))).toBe(true);
    for (const role of [
      'market',
      'market_operator',
      'registrator',
      'manager',
    ]) {
      let denied = false;
      try {
        denied = guard.canActivate(ctxFor([role])) === false;
      } catch (e) {
        denied = e instanceof ForbiddenException;
      }
      expect(denied).toBe(true);
    }
  });

  it('TC8: ai-service javobi (maskalangan matn/telefon) o‘zgarmay uzatiladi', async () => {
    const trace = {
      order_id: '10',
      draft_id: DRAFT,
      source_text: 'Ali [TEL_1] Asaka',
      ai_suggestion: { phone_masked: '+99890*****67' },
      edited_fields: ['district_id'],
    };
    const fx = setup({ trace });
    const res = await fx.controller.aiTrace('10');
    expect(res.data).toEqual(trace);
    expect(JSON.stringify(res)).not.toMatch(/\+998\d{9}/);
    expect(fx.ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.draft.trace_by_order' },
      { order_id: '10' },
    );
  });

  it('AI’dan yaratilmagan buyurtma → 404; noto‘g‘ri id → 400', async () => {
    const fx = setup({ trace: null });
    await expect(fx.controller.aiTrace('10')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(fx.controller.aiTrace('abc')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
