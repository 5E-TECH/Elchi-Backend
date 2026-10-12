import { ClientProxy } from '@nestjs/microservices';
import { defer, NEVER, TimeoutError } from 'rxjs';
import { rmqSend } from './rmq-client.helper';

describe('rmqSend total deadline', () => {
  it('stops retries at the total budget even when individual attempts are allowed longer', async () => {
    jest.useFakeTimers();
    let subscriptions = 0;
    const client = {
      send: () =>
        defer(() => {
          subscriptions += 1;
          return NEVER;
        }),
    } as unknown as ClientProxy;
    try {
      const pending = rmqSend(
        client,
        { cmd: 'test.read' },
        {},
        {
          timeoutMs: 100,
          retries: 5,
          retryBaseDelayMs: 10,
          deadlineMs: 50,
        },
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(55);
      await assertion;
      expect(subscriptions).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
