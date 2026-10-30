import {
  type ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
} from '@nestjs/common';
import { TimeoutError } from 'rxjs';
import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  SESSION_TOO_NEW,
  publicErrorData,
  publicErrorFields,
} from './public-error-fields';

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

  it('(ZDweRm02) Nest standart 403 matni (RolesGuard) o‘zbekcha, status o‘sha', () => {
    const { host, status, json } = makeHost();

    filter.catch(new ForbiddenException('Forbidden resource'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        message: "Bu amal uchun ruxsat yo'q",
      }),
    );
  });

  it('(ZDweRm02) kod yozgan 403 matni o‘zgarmaydi', () => {
    const { host, json } = makeHost();

    filter.catch(new ForbiddenException('Hamkor faol emas'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hamkor faol emas' }),
    );
  });

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
  describe('(AF0fvJbw) xato `data` — faqat reason / usage / details', () => {
    const typedHost = () => {
      const h = makeHost();
      return {
        host: h.host as ArgumentsHost,
        status: h.status,
        body: () => (h.json.mock.calls as unknown[][])[0][0],
      };
    };

    it('⭐ tuman o‘chirish 400 (RPC obyekt): reason + usage o‘tadi, hint/boshqa kalit yo‘q', () => {
      const { host, status, body } = typedHost();

      filter.catch(
        {
          statusCode: 400,
          message:
            "Bu tumanda 5 ta buyurtma bor, shuning uchun uni o'chirib bo'lmaydi.",
          data: {
            reason: 'district_in_use',
            usage: { orders: 5, users: 0, branches: 1, transfer_batches: 0 },
            hint: {
              action: 'merge',
              method: 'POST',
              path: '/district/1/merge',
            },
            post_id: '77',
          },
        },
        host,
      );

      expect(status).toHaveBeenCalledWith(400);
      expect(body()).toEqual({
        statusCode: 400,
        message:
          "Bu tumanda 5 ta buyurtma bor, shuning uchun uni o'chirib bo'lmaydi.",
        data: {
          reason: 'district_in_use',
          usage: { orders: 5, users: 0, branches: 1, transfer_batches: 0 },
        },
      });
    });

    it('details (409 tafsiloti): tekis obyektlar ro‘yxati o‘tadi, ichma-ich qism tashlanadi', () => {
      const { host, body } = typedHost();

      filter.catch(
        {
          statusCode: 409,
          message: 'Bloklangan',
          data: {
            reason: 'post_has_blocked_orders',
            details: [
              { order_id: '11', status: 'sold', nested: { a: 1 } },
              'oddiy',
              42,
              [1, 2],
            ],
          },
        },
        host,
      );

      expect(body()).toEqual({
        statusCode: 409,
        message: 'Bloklangan',
        data: {
          reason: 'post_has_blocked_orders',
          details: [{ order_id: '11', status: 'sold' }, 'oddiy', 42],
        },
      });
    });

    it('HttpException javobidagi data ham (bir xil konvert); kod bilan birga', () => {
      const { host, body } = typedHost();

      filter.catch(
        new ForbiddenException({
          statusCode: 403,
          message: 'Yangi qurilma',
          code: SESSION_TOO_NEW,
          available_at: '2026-10-25T07:00:00.000Z',
          data: { reason: 'session_too_new' },
        }),
        host,
      );

      expect(body()).toEqual({
        statusCode: 403,
        message: 'Yangi qurilma',
        code: SESSION_TOO_NEW,
        available_at: '2026-10-25T07:00:00.000Z',
        data: { reason: 'session_too_new' },
      });
    });

    it('ruxsat etilgan kalit yo‘q / data null — `data` umuman yo‘q (konvert avvalgidek)', () => {
      for (const data of [null, undefined, {}, { secret: 'x' }, 'matn', [1]]) {
        const { host, body } = typedHost();
        filter.catch({ statusCode: 400, message: 'xato', data }, host);
        expect(body()).toEqual({ statusCode: 400, message: 'xato' });
      }
    });

    it('xavfsizlik: inson matni/ichki xabar reason sifatida, stack, kutubxona xatosi o‘tmaydi', () => {
      expect(
        publicErrorData({
          data: {
            reason:
              'QueryFailedError: duplicate key value violates "users_pkey"',
            usage: { orders: '5', 'Bad Key': 1, ok: Infinity, n: 2 },
            details: { stack: { at: 'x' }, msg: 'y'.repeat(300), code: 'E1' },
          },
        }),
      ).toEqual({
        // reason — mashina kodi emas; usage — faqat son + to'g'ri kalit;
        // details — ichma-ich `stack` va 256 dan uzun satr tashlanadi.
        usage: { n: 2 },
        details: { code: 'E1' },
      });

      // Error instansiyasi (axios / TypeORM va h.k.) — ichiga qaralmaydi.
      const lib = Object.assign(new Error('Request failed'), {
        statusCode: 400,
        data: { reason: 'leaked_reason' },
        response: { data: { reason: 'external' } },
      });
      const { host, body } = typedHost();
      filter.catch(lib, host);
      expect(body()).not.toHaveProperty('data');
      expect(JSON.stringify(body())).not.toMatch(/leaked_reason|external/);
    });

    it('5xx ham xom stack/ichki matnsiz: faqat ruxsat etilgan kalitlar', () => {
      const { host, body } = typedHost();
      filter.catch(
        {
          statusCode: 503,
          message: 'Servis javob bermadi',
          data: { reason: 'geo_usage_unavailable', stack: 'Error: at ...' },
        },
        host,
      );
      expect(body()).toEqual({
        statusCode: 503,
        message: 'Servis javob bermadi',
        data: { reason: 'geo_usage_unavailable' },
      });
    });

    it('details 50 tadan oshsa — kesiladi', () => {
      const details = Array.from({ length: 80 }, (_, i) => ({ order_id: i }));
      const out = publicErrorData({ data: { details } });
      expect(out?.details).toHaveLength(50);
    });

    it('(tf324cXN) details obyekti ichidagi tekis ro‘yxat o‘tadi (bir daraja), chuqurrog‘i tashlanadi', () => {
      const out = publicErrorData({
        data: {
          reason: 'count_mismatch',
          details: {
            reason: 'count_mismatch',
            kind: 'orders',
            mismatches: [
              {
                kind: 'orders',
                district: 'target',
                expected: 1254,
                actual: 1255,
                deep: { x: 1 },
              },
            ],
            rolled_back: { orders: 5 },
            // (Z1c1sNPT) tekis sonlar va oddiy ID ro'yxati o'tadi.
            rolled_back_orders: 5,
            rolled_back_users: 0,
            rolled_back_branches: 1,
            stranded_order_ids: ['7001', '7002'],
            empty: [],
          },
        },
      });
      expect(out).toEqual({
        reason: 'count_mismatch',
        details: {
          reason: 'count_mismatch',
          kind: 'orders',
          mismatches: [
            {
              kind: 'orders',
              district: 'target',
              expected: 1254,
              actual: 1255,
            },
          ],
          rolled_back_orders: 5,
          rolled_back_users: 0,
          rolled_back_branches: 1,
          stranded_order_ids: ['7001', '7002'],
        },
      });
    });
  });
});
