/**
 * `executeIdempotent` — modul funksiyasi. Haqiqiy implementatsiya ishlaydi,
 * lekin controller unga qanday opsiyalar uzatganini ko'rish uchun spy bilan
 * o'raladi.
 */
jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return { ...actual, executeIdempotent: jest.fn(actual.executeIdempotent) };
});

import { executeIdempotent as executeIdempotentFn } from '@app/common';
import type { RmqContext } from '@nestjs/microservices';
import { OrderServiceController } from './order-service.controller';

/** Test dubli — kerakli tipga keltiriladi (faqat ishlatilgan metodlar bor). */
const stub = <T>(value: unknown): T => value as T;

const executeIdempotent = jest.mocked(executeIdempotentFn);

/**
 * wgqxS0Cp #13 — ai-confirm dublikat himoyasi (order-service tomoni).
 *
 * Gateway har AI buyurtma uchun deterministik
 * `request_id = 'ai-dedupe:' + sha256(...)` yuboradi. FAQAT shu prefiks uchun
 * `order.create` idempotency'si TTL 10 daqiqa, `reclaimFailed` va `markReplay`
 * bilan ishlaydi. Oddiy POST /orders (tasodifiy UUID) xatti-harakati
 * baytma-bayt o'zgarmasligi SHART — unga hech qanday opsiya qo'shilmaydi.
 */

const DTO = {
  market_id: '121',
  customer_id: '55',
  district_id: '20',
  total_price: 320000,
  items: [{ product_id: '12', quantity: 1 }],
};
const REQUESTER = { id: '7', roles: ['market'] };

function setup(acquire: Record<string, unknown> = { status: 'new' }) {
  const rmqService = {
    ack: jest.fn(),
    nack: jest.fn(),
    nackForError: jest.fn(),
  };
  const lifecycle = {
    create: jest.fn().mockResolvedValue({
      statusCode: 201,
      message: 'success',
      data: { id: '9001' },
    }),
  };
  const idem = {
    tryAcquire: jest.fn().mockResolvedValue(acquire),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new OrderServiceController(
    stub(rmqService),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub(lifecycle),
    stub(idem),
    stub({ resolve: jest.fn() }),
  );
  return { controller, lifecycle, idem };
}

const ctx = stub<RmqContext>({});

beforeEach(() => {
  executeIdempotent.mockClear();
});

describe('order.create — ai-dedupe opsiyalari', () => {
  it("'ai-dedupe:' request_id — TTL 10 daqiqa, reclaimFailed, markReplay uzatiladi", async () => {
    const { controller, lifecycle, idem } = setup();
    const requestId = 'ai-dedupe:' + 'a'.repeat(64);

    await controller.create(
      { dto: DTO, requester: REQUESTER, request_id: requestId },
      ctx,
    );

    expect(executeIdempotent).toHaveBeenCalledTimes(1);
    expect(executeIdempotent.mock.calls[0][3]).toEqual({
      requestId,
      pattern: 'order.create',
      completedTtlMs: 600_000,
      reclaimFailed: true,
      markReplay: true,
    });
    // tryAcquire ga TTL va reclaim yetib boradi
    expect(idem.tryAcquire).toHaveBeenCalledWith(
      `order.create:${requestId}`,
      'order.create',
      undefined,
      { completedTtlMs: 600_000, reclaimFailed: true },
    );
    expect(lifecycle.create).toHaveBeenCalledWith(DTO, REQUESTER);
  });

  it("oddiy request_id (UUID) — hech qanday qo'shimcha opsiya YO'Q", async () => {
    const { controller, idem } = setup();
    const requestId = '3f1c2b1e-9a55-4d8e-8c1b-2f7a9c0d1e2f';

    await controller.create(
      { dto: DTO, requester: REQUESTER, request_id: requestId },
      ctx,
    );

    const opts = executeIdempotent.mock.calls[0][3] as unknown as Record<
      string,
      unknown
    >;
    expect(opts).toEqual({ requestId, pattern: 'order.create' });
    expect(Object.keys(opts).sort()).toEqual(['pattern', 'requestId']);
    expect(idem.tryAcquire).toHaveBeenCalledWith(
      `order.create:${requestId}`,
      'order.create',
      undefined,
      undefined,
    );
  });

  it("request_id yo'q — avvalgidek {requestId: undefined, pattern}", async () => {
    const { controller } = setup();
    await controller.create({ dto: DTO, requester: REQUESTER }, ctx);
    const opts = executeIdempotent.mock.calls[0][3] as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(opts).sort()).toEqual(['pattern', 'requestId']);
    expect(opts.requestId).toBeUndefined();
  });

  it("prefiks o'rtada bo'lsa (startsWith emas) — opsiya qo'shilmaydi", async () => {
    const { controller } = setup();
    await controller.create(
      { dto: DTO, requester: REQUESTER, request_id: 'x-ai-dedupe:abc' },
      ctx,
    );
    const opts = executeIdempotent.mock.calls[0][3] as unknown as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty('markReplay');
    expect(opts).not.toHaveProperty('completedTtlMs');
    expect(opts).not.toHaveProperty('reclaimFailed');
  });

  it('ai-dedupe takroriy (keshdan) javob — idempotent_replay:true, create chaqirilmaydi', async () => {
    const cached = {
      statusCode: 201,
      message: 'success',
      data: { id: '9001' },
    };
    const { controller, lifecycle } = setup({
      status: 'cached',
      response: cached,
    });

    const res = await controller.create(
      { dto: DTO, requester: REQUESTER, request_id: 'ai-dedupe:abc' },
      ctx,
    );

    expect(res).toEqual({ ...cached, idempotent_replay: true });
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('oddiy takroriy javob — belgisiz (mavjud xatti-harakat)', async () => {
    const cached = {
      statusCode: 201,
      message: 'success',
      data: { id: '9001' },
    };
    const { controller } = setup({ status: 'cached', response: cached });

    const res = await controller.create(
      { dto: DTO, requester: REQUESTER, request_id: 'plain-uuid' },
      ctx,
    );

    expect(res).toBe(cached);
    expect(res).not.toHaveProperty('idempotent_replay');
  });
});
