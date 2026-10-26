import { ServiceUnavailableException, HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ThrottlerException } from '@nestjs/throttler';
import {
  AllExceptionsFilter,
  DEFAULT_RETRY_AFTER_SECONDS,
  retryAfterFromException,
} from './all-exceptions.filter';
import { RpcExceptionFilter } from './rpc-exception.filter';
import { SESSION_CHECK_UNAVAILABLE } from './public-error-fields';

jest.mock('../sentry/sentry.helper', () => ({
  captureException: jest.fn(),
}));

/** Express Response'ga o'xshash: sarlavhalar haqiqatan saqlanadi. */
function makeHost(preset: Record<string, string> = {}) {
  const headers = new Map<string, string>(
    Object.entries(preset).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = {
    status,
    setHeader: jest.fn((name: string, value: string) =>
      headers.set(name.toLowerCase(), value),
    ),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as never;
  return { host, headers, status, json };
}

describe('oFfOWGuo — 429 / 503 javoblarida Retry-After', () => {
  const filter = new AllExceptionsFilter();

  it('⭐ 503 SESSION_CHECK_UNAVAILABLE → Retry-After: 5 (FE kutib qayta urinadi)', () => {
    const { host, headers, status, json } = makeHost();
    filter.catch(
      new ServiceUnavailableException({
        statusCode: 503,
        message: 'x',
        code: SESSION_CHECK_UNAVAILABLE,
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(headers.get('retry-after')).toBe('5');
    expect(json.mock.calls[0][0]).toMatchObject({
      code: SESSION_CHECK_UNAVAILABLE,
    });
  });

  it('ThrottlerGuard qo‘ygan Retry-After saqlanadi (ustiga yozilmaydi)', () => {
    const { host, headers } = makeHost({ 'Retry-After': '17' });
    filter.catch(new ThrottlerException(), host);
    expect(headers.get('retry-after')).toBe('17');
  });

  it('sarlavhasiz 429 → sukut 60', () => {
    const { host, headers } = makeHost();
    filter.catch(new ThrottlerException(), host);
    expect(headers.get('retry-after')).toBe(
      String(DEFAULT_RETRY_AFTER_SECONDS[429]),
    );
  });

  it('identity RPC 429 (LOGIN_LOCKED retry_after_seconds / OTP retry_after) → shu qiymat', () => {
    const a = makeHost();
    filter.catch(
      {
        statusCode: 429,
        message: 'qulf',
        code: 'LOGIN_LOCKED',
        retry_after_seconds: 299.2,
      },
      a.host,
    );
    expect(a.headers.get('retry-after')).toBe('300');

    const b = makeHost();
    filter.catch({ statusCode: 429, message: 'otp', retry_after: 42 }, b.host);
    expect(b.headers.get('retry-after')).toBe('42');
  });

  it('RpcExceptionFilter ham Retry-After qo‘yadi', () => {
    const { host, headers } = makeHost();
    new RpcExceptionFilter().catch(
      new RpcException({ statusCode: 429, message: 'otp', retry_after: 30 }),
      host,
    );
    expect(headers.get('retry-after')).toBe('30');
  });

  it('boshqa statuslarda Retry-After qo‘yilmaydi', () => {
    const { host, headers } = makeHost();
    filter.catch({ statusCode: 400, message: 'bad', retry_after: 5 }, host);
    expect(headers.has('retry-after')).toBe(false);
  });

  it('retryAfterFromException: manfiy / son emas — e’tiborsiz', () => {
    expect(
      retryAfterFromException({ retry_after_seconds: -1 }),
    ).toBeUndefined();
    expect(retryAfterFromException({ retry_after: 'abc' })).toBeUndefined();
    expect(retryAfterFromException({ response: { retry_after: '9' } })).toBe(9);
  });
});
