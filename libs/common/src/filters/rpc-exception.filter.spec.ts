import { RpcException } from '@nestjs/microservices';
import { RpcExceptionFilter } from './rpc-exception.filter';

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
});
