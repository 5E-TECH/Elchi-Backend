import {
  type ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
} from '@nestjs/common';
import { TimeoutError } from 'rxjs';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { SESSION_TOO_NEW, publicErrorFields } from './public-error-fields';

jest.mock('../sentry/sentry.helper', () => ({
  captureException: jest.fn(),
}));

function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  };
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps an rxjs downstream TimeoutError to 504 Gateway Timeout', () => {
    const { host, status, json } = makeHost();

    filter.catch(new TimeoutError(), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(504);
    expect(body.message).toMatch(/timeout/i);
  });

  it('preserves an HttpException status (does not mislabel as 504)', () => {
    const { host, status, json } = makeHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json.mock.calls[0][0].message).toBe('bad input');
  });

  it('falls back to 500 for an unknown error', () => {
    const { host, status, json } = makeHost();

    filter.catch(new Error('kaboom'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json.mock.calls[0][0].statusCode).toBe(500);
  });

  describe('(Elchi Pochta #3) mashina kodi — faqat ro‘yxatdagi kod va maydonlar', () => {
    const AVAILABLE_AT = '2026-10-25T07:00:00.000Z';
    const typedHost = () => {
      const h = makeHost();
      return {
        host: h.host as ArgumentsHost,
        status: h.status,
        body: () => (h.json.mock.calls as unknown[][])[0][0],
      };
    };

    it('⭐ downstream RPC xatosi (oddiy obyekt): code + available_at javobga o‘tadi, data/ichki maydon o‘tmaydi', () => {
      const { host, status, body } = typedHost();

      filter.catch(
        {
          statusCode: 403,
          message: 'Yangi qurilma',
          data: { secret: 'x' },
          code: SESSION_TOO_NEW,
          available_at: AVAILABLE_AT,
          internal: 'yashirin',
        },
        host,
      );

      expect(status).toHaveBeenCalledWith(403);
      expect(body()).toEqual({
        statusCode: 403,
        message: 'Yangi qurilma',
        code: SESSION_TOO_NEW,
        available_at: AVAILABLE_AT,
      });
    });

    it('HttpException javob obyektidagi kod ham (bir xil konvert)', () => {
      const { host, body } = typedHost();

      filter.catch(
        new ForbiddenException({
          statusCode: 403,
          message: 'Yangi qurilma',
          code: SESSION_TOO_NEW,
          available_at: AVAILABLE_AT,
        }),
        host,
      );

      expect(body()).toEqual({
        statusCode: 403,
        message: 'Yangi qurilma',
        code: SESSION_TOO_NEW,
        available_at: AVAILABLE_AT,
      });
    });

    it('ro‘yxatda yo‘q kod (Postgres 23505, Node ECONNREFUSED) — konvert avvalgidek', () => {
      for (const code of ['23505', 'ECONNREFUSED', 'toString', '__proto__']) {
        const { host, body } = typedHost();
        filter.catch({ statusCode: 409, message: 'conflict', code }, host);
        expect(body()).toEqual({ statusCode: 409, message: 'conflict' });
      }
    });

    it('maydon qiymati faqat oddiy tur (obyekt / uzun satr chiqmaydi)', () => {
      expect(
        publicErrorFields({ code: SESSION_TOO_NEW, available_at: { a: 1 } }),
      ).toEqual({ code: SESSION_TOO_NEW });
      expect(
        publicErrorFields({
          code: SESSION_TOO_NEW,
          available_at: 'x'.repeat(300),
        }),
      ).toEqual({ code: SESSION_TOO_NEW });
      expect(publicErrorFields(null)).toEqual({});
      expect(publicErrorFields('boom')).toEqual({});
    });
  });
});
