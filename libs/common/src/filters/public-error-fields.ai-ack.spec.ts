import {
  ConflictException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AI_CHECKS_NOT_ACKNOWLEDGED,
  AI_CHECKS_UNAVAILABLE,
  AI_DRAFT_ITEM_NOT_FOUND,
  AI_DRAFT_NOT_FOUND,
  AI_DRAFT_REQUIRED,
} from '../ai/ai-draft.contract';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { publicErrorFields } from './public-error-fields';

jest.mock('../sentry/sentry.helper', () => ({
  captureException: jest.fn(),
}));

/**
 * AI ack (round-3 S5/S6): ro'yxat maydonlari (`indexes`, `orders`,
 * `missing`) — chegaralar va shakl. Barcha ma'lumot soxta.
 */
describe('publicErrorFields — AI ack ro‘yxat maydonlari', () => {
  it.each([AI_DRAFT_REQUIRED, AI_DRAFT_NOT_FOUND, AI_DRAFT_ITEM_NOT_FOUND])(
    '%s — `indexes: number[]`; `orders` chiqmaydi',
    (code) => {
      expect(
        publicErrorFields({ code, indexes: [0, 3], orders: [1], extra: 'x' }),
      ).toEqual({ code, indexes: [0, 3] });
    },
  );

  it('ro‘yxat ≤50 element bilan kesiladi', () => {
    const indexes = Array.from({ length: 80 }, (_, i) => i);
    const out = publicErrorFields({ code: AI_DRAFT_REQUIRED, indexes });
    expect(out.indexes).toHaveLength(50);
    expect(out.indexes).toEqual(indexes.slice(0, 50));
  });

  it('orders[]: tekis obyekt, ichki ro‘yxat ≤50 va faqat oddiy qiymatlar; chuqurroq qism tashlanadi', () => {
    const missing = Array.from({ length: 70 }, (_, i) => `code_${i}`);
    const out = publicErrorFields({
      code: AI_CHECKS_NOT_ACKNOWLEDGED,
      missing: ['price_check', { nested: true }, ['deep']],
      orders: [
        {
          index: 0,
          missing: [...missing, { deep: 1 }, ['x']],
          nested: { a: 1 },
          BadKey: 1,
        },
        'price_check',
        ['array', 'item'],
        ...Array.from({ length: 60 }, (_, i) => ({ index: i + 1 })),
      ],
    });
    // Tekis obyekt ruxsat; ichma-ich ro'yxat (['deep']) tashlanadi.
    expect(out.missing).toEqual(['price_check', { nested: true }]);
    const orders = out.orders as unknown[];
    // 50 tadan keyingilari kesildi; ichma-ich ro'yxat (['array','item']) tashlandi.
    expect(orders).toHaveLength(49);
    expect(orders[0]).toEqual({ index: 0, missing: missing.slice(0, 50) });
    expect(orders[1]).toBe('price_check');
    expect(orders[2]).toEqual({ index: 1 });
  });

  it('AI_CHECKS_UNAVAILABLE — retryable, retry_after_seconds (ro‘yxat emas)', () => {
    expect(
      publicErrorFields({
        code: AI_CHECKS_UNAVAILABLE,
        retryable: true,
        retry_after_seconds: 5,
        indexes: [1],
      }),
    ).toEqual({
      code: AI_CHECKS_UNAVAILABLE,
      retryable: true,
      retry_after_seconds: 5,
    });
  });
});

describe('AllExceptionsFilter — AI ack xatolari', () => {
  const run = (error: unknown) => {
    const headers = new Map<string, string>();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const response = {
      status,
      setHeader: jest.fn((k: string, v: string) =>
        headers.set(k.toLowerCase(), v),
      ),
      getHeader: (k: string) => headers.get(k.toLowerCase()),
    };
    new AllExceptionsFilter().catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
    return {
      status: status.mock.calls[0][0] as number,
      body: json.mock.calls[0][0] as Record<string, unknown>,
      headers,
    };
  };

  it('503 AI_CHECKS_UNAVAILABLE → Retry-After: 5', () => {
    const { status, body, headers } = run(
      new ServiceUnavailableException({
        statusCode: 503,
        code: AI_CHECKS_UNAVAILABLE,
        message: 'x',
        retryable: true,
        retry_after_seconds: 5,
      }),
    );
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(headers.get('retry-after')).toBe('5');
    expect(body).toMatchObject({
      statusCode: 503,
      code: AI_CHECKS_UNAVAILABLE,
      retryable: true,
      retry_after_seconds: 5,
    });
  });

  it('409 CHECKS_NOT_ACKNOWLEDGED — Retry-After yo‘q, orders/missing bor', () => {
    const { status, body, headers } = run(
      new ConflictException({
        statusCode: 409,
        code: AI_CHECKS_NOT_ACKNOWLEDGED,
        message: 'x',
        missing: ['price_check'],
        orders: [{ index: 2, missing: ['price_check'] }],
      }),
    );
    expect(status).toBe(409);
    expect(headers.has('retry-after')).toBe(false);
    expect(body).toMatchObject({
      code: AI_CHECKS_NOT_ACKNOWLEDGED,
      missing: ['price_check'],
      orders: [{ index: 2, missing: ['price_check'] }],
    });
  });
});
