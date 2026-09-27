import type { ErrorEvent } from '@sentry/node';
import { requestContext } from '../context/request-context';
import { initSentry } from './sentry.helper';
import { scrubSentryEvent, type ScrubbableSentryEvent } from './scrub-pii';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setTag: jest.fn(),
  withScope: jest.fn(),
  captureException: jest.fn(),
  flush: jest.fn(),
}));

describe('scrubSentryEvent (HD5zOyBp #18)', () => {
  it.each([
    'https://api.elchipochta.uz/orders/ai-parse',
    'https://api.elchipochta.uz/orders/ai-confirm?x=1',
    '/orders/ai-availability',
  ])('AI buyurtma yo‘li (%s) — request.data olib tashlanadi', (url) => {
    const out = scrubSentryEvent({
      request: {
        url,
        data: { text: 'Aziz 90 123 45 67 Chilonzor 5-uy', images: ['...'] },
      },
    });

    expect(out.request).toEqual({ url });
    expect(out.request).not.toHaveProperty('data');
  });

  it('boshqa yo‘llarda request.data saqlanadi', () => {
    const data = { market_id: '12' };
    const out = scrubSentryEvent({
      request: { url: 'https://api.elchipochta.uz/orders/123', data },
    });

    expect(out.request).toEqual({
      url: 'https://api.elchipochta.uz/orders/123',
      data,
    });
  });

  it('message, exception.values[].value va extra satrlaridagi telefonlar maskalanadi', () => {
    const out = scrubSentryEvent({
      message: 'order.create failed for 90 123 45 67, narx 125 000 000',
      logentry: { message: 'phone +998 (91) 234-56-78' },
      exception: {
        values: [
          { value: 'Duplicate phone 998931112233' },
          { value: 'no phone here, 1 500 000 so‘m' },
          {},
        ],
      },
      extra: {
        phone: '+998901234567',
        note: 'qayta qo‘ng‘iroq 0 (95) 111 22 33',
        count: 3,
        nested: { phone_number: '+998901234567' },
      },
    });

    expect(out.message).toBe(
      'order.create failed for +99890*****67, narx 125 000 000',
    );
    expect(out.logentry?.message).toBe('phone +99891*****78');
    expect(out.exception?.values).toEqual([
      { value: 'Duplicate phone +99893*****33' },
      { value: 'no phone here, 1 500 000 so‘m' },
      {},
    ]);
    expect(out.extra).toEqual({
      phone: '+99890*****67',
      note: 'qayta qo‘ng‘iroq +99895*****33',
      count: 3,
      nested: { phone_number: '+998901234567' },
    });
  });

  it('sof: kirish event’i o‘zgarmaydi', () => {
    const event: ScrubbableSentryEvent = {
      message: 'tel 901234567',
      request: { url: '/orders/ai-parse', data: { text: 'x' } },
      exception: { values: [{ value: 'tel 901234567' }] },
      extra: { a: 'tel 901234567' },
    };
    const snapshot = structuredClone(event);

    const out = scrubSentryEvent(event);

    expect(event).toEqual(snapshot);
    expect(out).not.toBe(event);
    expect(out.message).toBe('tel +99890*****67');
  });

  it('PII maydonlari bo‘lmagan event o‘zgarishsiz o‘tadi', () => {
    const event = {
      message: 'plain error, 750000 so‘m',
      level: 'error',
      tags: { service: 'ai-service' },
    };

    expect(scrubSentryEvent(event)).toEqual(event);
  });
});

describe('initSentry beforeSend → scrubSentryEvent', () => {
  it('trace/user teglaridan keyin event tozalanadi', () => {
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    const Sentry = jest.requireMock<{ init: jest.Mock<void, [unknown]> }>(
      '@sentry/node',
    );

    initSentry({ serviceName: 'ai-service', dsn: 'https://k@example.test/1' });

    const options = Sentry.init.mock.calls[0][0] as {
      beforeSend: (event: ErrorEvent) => ErrorEvent | null;
    };
    const event = {
      type: undefined,
      message: 'fail 90 123 45 67',
      request: { url: '/orders/ai-parse', data: { text: 'Aziz 901234567' } },
    } as ErrorEvent;

    const out = requestContext.run({ traceId: 't-1', userId: 'u-1' }, () =>
      options.beforeSend(event),
    );

    expect(out?.tags).toEqual({ trace_id: 't-1' });
    expect(out?.user).toEqual({ id: 'u-1' });
    expect(out?.message).toBe('fail +99890*****67');
    expect(out?.request).toEqual({ url: '/orders/ai-parse' });

    onSpy.mockRestore();
  });
});
