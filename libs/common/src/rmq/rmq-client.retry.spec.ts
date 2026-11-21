import { ClientProxy, RpcException } from '@nestjs/microservices';
import { defer, NEVER, Observable, of, throwError, TimeoutError } from 'rxjs';
import { isRetryableRmqError, rmqSend } from './rmq-client.helper';

/**
 * `rmqSend` faqat transport xatosida (timeout, mahalliy Error) qayta yuboradi. @nestjs/microservices 11 da
 * boshqa servis qaytargan xato `ClientProxy.serializeError` orqali o'zgarmasdan,
 * ya'ni ODDIY OBYEKT bo'lib keladi — `RpcException` emas.
 */
function clientFrom(factory: () => Observable<unknown>) {
  let subscriptions = 0;
  const client = {
    send: () =>
      defer(() => {
        subscriptions += 1;
        return factory();
      }),
  } as unknown as ClientProxy;
  return { client, attempts: () => subscriptions };
}

describe('rmqSend retry policy', () => {
  it('does not retry a remote business error delivered as a plain object', async () => {
    const remoteError = { statusCode: 400, message: 'Mahsulot topilmadi' };
    const { client, attempts } = clientFrom(() =>
      throwError(() => remoteError),
    );

    await expect(
      rmqSend(client, { cmd: 'order.create' }, {}, { retryBaseDelayMs: 1 }),
    ).rejects.toBe(remoteError);
    expect(attempts()).toBe(1);
  });

  it('does not retry a remote 5xx error delivered as a plain object', async () => {
    const remoteError = { status: 'error', message: 'Internal server error' };
    const { client, attempts } = clientFrom(() =>
      throwError(() => remoteError),
    );

    await expect(
      rmqSend(client, { cmd: 'order.find_all' }, {}, { retryBaseDelayMs: 1 }),
    ).rejects.toBe(remoteError);
    expect(attempts()).toBe(1);
  });

  it('does not retry an RpcException or the Nest "no handler" string', async () => {
    const rpc = new RpcException({ statusCode: 403, message: 'Forbidden' });
    const rpcClient = clientFrom(() => throwError(() => rpc));
    await expect(
      rmqSend(rpcClient.client, { cmd: 'x' }, {}, { retryBaseDelayMs: 1 }),
    ).rejects.toBe(rpc);
    expect(rpcClient.attempts()).toBe(1);

    const noHandler =
      'There is no matching message handler defined in the remote service.';
    const strClient = clientFrom(() => throwError(() => noHandler));
    await expect(
      rmqSend(strClient.client, { cmd: 'x' }, {}, { retryBaseDelayMs: 1 }),
    ).rejects.toBe(noHandler);
    expect(strClient.attempts()).toBe(1);
  });

  it('retries a local transport Error (connection blip) — NDmZMzCP / dzyVftBx', async () => {
    let call = 0;
    const { client, attempts } = clientFrom(() => {
      call += 1;
      return call === 1
        ? throwError(() => new Error('connection closed'))
        : of({ ok: true });
    });

    await expect(
      rmqSend(client, { cmd: 'x' }, {}, { retries: 1, retryBaseDelayMs: 1 }),
    ).resolves.toEqual({ ok: true });
    expect(attempts()).toBe(2);
  });

  it('isRetryableRmqError: transport — ha, remote javob — yo‘q', () => {
    expect(isRetryableRmqError(new TimeoutError())).toBe(true);
    expect(isRetryableRmqError(new Error('channel closed'))).toBe(true);
    expect(isRetryableRmqError(new RpcException('x'))).toBe(false);
    expect(isRetryableRmqError({ statusCode: 409, message: 'x' })).toBe(false);
    expect(isRetryableRmqError('no matching message handler')).toBe(false);
    expect(isRetryableRmqError(null)).toBe(false);
  });

  it('retries on rxjs TimeoutError and succeeds when a later attempt answers', async () => {
    let call = 0;
    const { client, attempts } = clientFrom(() => {
      call += 1;
      return call === 1 ? NEVER : of({ ok: true });
    });

    await expect(
      rmqSend(client, { cmd: 'x' }, {}, { timeoutMs: 20, retryBaseDelayMs: 1 }),
    ).resolves.toEqual({ ok: true });
    expect(attempts()).toBe(2);
  });

  it('gives up with TimeoutError after the configured retries', async () => {
    const { client, attempts } = clientFrom(() => NEVER);

    await expect(
      rmqSend(
        client,
        { cmd: 'x' },
        {},
        { timeoutMs: 10, retries: 2, retryBaseDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(attempts()).toBe(3);
  });
});
