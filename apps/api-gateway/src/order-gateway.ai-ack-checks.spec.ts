import 'reflect-metadata';
import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError, type Observable } from 'rxjs';
import {
  AllExceptionsFilter,
  Where_deliver,
  publicErrorFields,
  type AiDraftPreviewSnapshot,
} from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import type { AiStatusPoller } from './ai/ai-status.poller';
import { aiPhoneDigest } from './ai-order/ai-edited-fields';
import { missingAckChecks, requiredAckChecks } from './ai-order/ai-ack-checks';
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

function setup(
  previews: AiDraftPreviewSnapshot[] | null,
  opts: { contextError?: boolean } = {},
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
        data: { id: payload.id, status: 'active', add_order: true },
      });
    }
    return of({ data: null });
  });
  let next = 7000;
  orderC.send.mockImplementation(() => of({ data: { id: String(next++) } }));
  ai.send.mockImplementation((pattern) => {
    if (pattern.cmd === 'ai.draft.confirm_context') {
      return opts.contextError
        ? throwError(() => new Error('ai down'))
        : of({
            drafts: [
              {
                draft_id: DRAFT,
                model: 'claude-sonnet-5',
                prompt_version: '2026-11-14.1',
                preview_count: 3,
                cost_usd: 0.1,
                cost_uzs: 1280,
                previews,
              },
            ],
          });
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
  return { controller, creates };
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

  it('snapshot yo‘q (eski / saqlanmagan draft) — fail-open, checks_unverified', async () => {
    const noPreview = setup(null);
    const r1 = await noPreview.controller.aiConfirm(
      { orders: [order(0)] },
      marketReq,
    );
    expect(r1.data.results[0].ok).toBe(true);
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
