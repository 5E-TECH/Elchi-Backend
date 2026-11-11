import { ExecutionContext } from '@nestjs/common';
import {
  CARRIER_THROTTLE_DEFAULT_LIMIT,
  CarrierThrottlerGuard,
  carrierThrottleLimit,
  carrierThrottleTtlMs,
  readPositiveIntEnv,
} from './carrier-throttler.guard';

type GuardInternals = {
  getTracker(req: Record<string, unknown>): Promise<string>;
  generateKey(ctx: ExecutionContext, suffix: string, name: string): string;
};

const guard = Object.create(
  CarrierThrottlerGuard.prototype,
) as unknown as GuardInternals;

const ctxFor = (handlerName: string) =>
  ({
    getClass: () => ({ name: 'CarrierGatewayController' }),
    getHandler: () => ({ name: handlerName }),
  }) as unknown as ExecutionContext;

describe('CarrierThrottlerGuard', () => {
  const envBackup = { ...process.env };
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('tracker — carrier id (IP emas)', async () => {
    await expect(guard.getTracker({ carrier: { id: '3' } })).resolves.toBe(
      'carrier-3',
    );
  });

  it('⭐ kalit endpointga bog‘liq EMAS — bitta carrier, bitta savat', () => {
    const scan = guard.generateKey(ctxFor('scan'), 'carrier-3', 'default');
    const status = guard.generateKey(
      ctxFor('updateStatus'),
      'carrier-3',
      'default',
    );
    const other = guard.generateKey(ctxFor('scan'), 'carrier-4', 'default');
    expect(scan).toBe(status);
    expect(scan).not.toBe(other);
  });

  it('env: bo‘sh / xato / 0 — sukut (429 yoki 500 emas); to‘g‘ri son — o‘sha', () => {
    for (const bad of ['', '  ', 'abc', '0', '-5', '1.5']) {
      process.env.CARRIER_THROTTLE_LIMIT = bad;
      expect(carrierThrottleLimit()).toBe(CARRIER_THROTTLE_DEFAULT_LIMIT);
    }
    process.env.CARRIER_THROTTLE_LIMIT = '300';
    expect(carrierThrottleLimit()).toBe(300);
    delete process.env.CARRIER_THROTTLE_TTL_MS;
    expect(carrierThrottleTtlMs()).toBe(60_000);
    expect(readPositiveIntEnv('NO_SUCH_KEY_X', 7)).toBe(7);
  });
});
