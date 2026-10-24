import type { ArgumentsHost } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { RpcExceptionFilter } from './rpc-exception.filter';
import { SESSION_TOO_NEW } from './public-error-fields';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as any;
  return { host, status, json };
}

describe('RpcExceptionFilter', () => {
  it('joins array validation messages (parity with AllExceptionsFilter)', () => {
    const { host, status, json } = makeHost();

    new RpcExceptionFilter().catch(
      new RpcException({
        statusCode: 400,
        message: ['name is required', 'phone is invalid'],
      }) as any,
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'name is required. phone is invalid',
      }),
    );
  });

  it('passes a string message through and defaults to 500', () => {
    const { host, status, json } = makeHost();

    new RpcExceptionFilter().catch(new RpcException('boom') as any, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'boom' }),
    );
  });

  it('(Elchi Pochta #3) ro‘yxatdagi mashina kodi va maydoni o‘tadi, boshqasi yo‘q', () => {
    const h = makeHost();

    new RpcExceptionFilter().catch(
      new RpcException({
        statusCode: 403,
        message: 'Yangi qurilma',
        data: null,
        code: SESSION_TOO_NEW,
        available_at: '2026-10-25T07:00:00.000Z',
        internal: 'yashirin',
      }),
      h.host as ArgumentsHost,
    );

    expect(h.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Yangi qurilma',
      code: SESSION_TOO_NEW,
      available_at: '2026-10-25T07:00:00.000Z',
    });
  });
  it('(AF0fvJbw) RpcException data: reason/usage o‘tadi, boshqa kalit yo‘q; bo‘sh bo‘lsa data yo‘q', () => {
    const h = makeHost();
    new RpcExceptionFilter().catch(
      new RpcException({
        statusCode: 400,
        message: 'Bu viloyatda 3 ta tuman bor',
        data: {
          reason: 'region_has_districts',
          districts: 3,
          usage: { orders: 2, posts: 1 },
        },
      }),
      h.host as ArgumentsHost,
    );
    expect(h.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'Bu viloyatda 3 ta tuman bor',
      data: { reason: 'region_has_districts', usage: { orders: 2, posts: 1 } },
    });

    const empty = makeHost();
    new RpcExceptionFilter().catch(
      new RpcException({ statusCode: 404, message: 'yo‘q', data: null }),
      empty.host as ArgumentsHost,
    );
    expect(empty.json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'yo‘q',
    });
  });
});
