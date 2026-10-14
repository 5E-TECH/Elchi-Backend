import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Logger } from '@nestjs/common';
import { defer, map, NEVER, Observable, of, timer } from 'rxjs';
import { RMQ_GATEWAY_TIMEOUT } from '@app/common';
import {
  ANALYTICS_READ_OPTIONS,
  AnalyticsServiceService,
} from './analytics-service.service';

/**
 * (VkwhHqvW) Analitika vaqt byudjeti — HAQIQIY `rmqSend` bilan (mock emas):
 *  - TC3: sekin order-service (7 s) ga har bo'lak BIR MARTA so'raladi
 *    (ilgari 3 urinish × 5 s + kechikishlar ≈ 15,6 s, 15 ta so'rov);
 *  - TC4: har rol yo'lining eng yomon jami vaqti gateway `timeout(8000)`
 *    dan kichik. Filial roli ilgari 4 ta ketma-ket bosqich edi (filial
 *    aniqlash → bo'laklar → filialni QAYTA aniqlash → branch.dashboard) —
 *    2,4 s javoblarda 9,6 s, ya'ni mijoz 504 olardi.
 */
type Responder = (cmd: string) => { delayMs: number | null; body: unknown };

function fakeClient(respond: Responder, calls: Map<string, number>) {
  return {
    send: (pattern: { cmd: string }) =>
      defer((): Observable<unknown> => {
        calls.set(pattern.cmd, (calls.get(pattern.cmd) ?? 0) + 1);
        const { delayMs, body } = respond(pattern.cmd);
        if (delayMs === null) return NEVER;
        return delayMs === 0 ? of(body) : timer(delayMs).pipe(map(() => body));
      }),
  } as unknown as ClientProxy;
}

const BODIES: Record<string, unknown> = {
  'order.analytics.overview': { acceptedCount: 3 },
  'order.analytics.courier_stat': { totalOrders: 3, soldOrders: 2 },
  'order.analytics.market_stat': { totalOrders: 4 },
  'branch.user.find_by_user': { data: { branch_id: '16' } },
  'identity.user.find_by_id': { data: { market_id: '5' } },
  'branch.dashboard': { data: { branchId: '16' } },
};

function make(respond: Responder) {
  const calls = new Map<string, number>();
  const client = fakeClient(respond, calls);
  const service = new AnalyticsServiceService(client, client, client, client);
  return { service, calls };
}

async function settle<T>(promise: Promise<T>) {
  const startedAt = Date.now();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null =
    null;
  promise.then(
    (value) => (outcome = { ok: true, value }),
    (error: unknown) => (outcome = { ok: false, error }),
  );
  while (outcome === null && Date.now() - startedAt < 60_000) {
    await jest.advanceTimersByTimeAsync(50);
  }
  return { outcome: outcome!, elapsedMs: Date.now() - startedAt };
}

const slowEverything: Responder = (cmd) => ({
  delayMs: 2400,
  body: BODIES[cmd] ?? { data: [] },
});

describe('VkwhHqvW — analitika vaqt byudjeti (haqiqiy rmqSend)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-14T07:00:00.000Z') });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ TC4: o`qish byudjeti (bitta urinish) gateway timeout(8000) ning yarmidan kichik', () => {
    expect(ANALYTICS_READ_OPTIONS.retries).toBe(0);
    expect(ANALYTICS_READ_OPTIONS.deadlineMs).toBeLessThanOrEqual(
      ANALYTICS_READ_OPTIONS.timeoutMs,
    );
    // Dashboard eng ko'pi 2 ketma-ket bosqich.
    expect(ANALYTICS_READ_OPTIONS.deadlineMs * 2).toBeLessThan(
      RMQ_GATEWAY_TIMEOUT,
    );
    expect(RMQ_GATEWAY_TIMEOUT).toBe(8000);
  });

  it('⭐ TC3: order-service 7 s javob bersa — har bo`lak 1 marta so`raladi, 503 ~2,5 s da (15,6 s emas)', async () => {
    const { service, calls } = make((cmd) => ({
      delayMs: 7000,
      body: BODIES[cmd] ?? { data: [] },
    }));

    const { outcome, elapsedMs } = await settle(
      service.getDashboard({ id: '1', roles: ['superadmin'] }, {}),
    );

    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error as RpcException;
    expect(error).toBeInstanceOf(RpcException);
    expect(error.getError()).toMatchObject({ statusCode: 503 });
    expect(elapsedMs).toBeLessThan(3000);
    for (const cmd of [
      'order.analytics.overview',
      'order.analytics.market_stats',
      'order.analytics.courier_stats',
      'order.analytics.top_markets',
      'order.analytics.top_branches',
    ]) {
      expect(calls.get(cmd)).toBe(1);
    }
  });

  it.each([
    ['superadmin', { id: '1', roles: ['superadmin'] }],
    ['menejer (JWT da branch_id YO`Q)', { id: '2', roles: ['manager'] }],
    [
      'registrator (JWT da branch_id bor)',
      {
        id: '3',
        roles: ['registrator'],
        branch_id: '16',
      },
    ],
    ['market operatori', { id: '4', roles: ['market_operator'] }],
    ['market', { id: '5', roles: ['market'] }],
    ['kuryer', { id: '6', roles: ['courier'] }],
  ])(
    '⭐ TC4: %s — har javob 2,4 s da kelganda dashboard < 8 s da 200 qaytaradi',
    async (_label, requester) => {
      const { service, calls } = make(slowEverything);

      const { outcome, elapsedMs } = await settle(
        service.getDashboard(requester, {}),
      );

      expect(outcome.ok).toBe(true);
      expect(elapsedMs).toBeLessThan(RMQ_GATEWAY_TIMEOUT);
      // Hech bir chaqiruv takrorlanmaydi (qayta urinish yo'q, filial ikki
      // marta aniqlanmaydi).
      for (const count of calls.values()) {
        expect(count).toBe(1);
      }
    },
  );

  it('menejer: filial dashboard`i order bo`laklari bilan PARALLEL (filial qayta aniqlanmaydi)', async () => {
    const { service, calls } = make(slowEverything);

    const { outcome, elapsedMs } = await settle(
      service.getDashboard({ id: '2', roles: ['manager'] }, {}),
    );

    expect(outcome.ok).toBe(true);
    expect(calls.get('branch.user.find_by_user')).toBe(1);
    expect(calls.get('branch.dashboard')).toBe(1);
    // 2 bosqich: filial aniqlash (2,4 s) + parallel bo'laklar (2,4 s).
    expect(elapsedMs).toBeLessThan(5000);
    const value = (outcome as { value: { data: Record<string, unknown> } })
      .value;
    expect(value.data.branchDashboard).toEqual({ branchId: '16' });
  });

  it('revenue: hamma bo`lak 2,4 s — bitta parallel bosqich (< 3 s)', async () => {
    const { service } = make(slowEverything);
    const { outcome, elapsedMs } = await settle(
      service.getRevenueStats({ id: '1', roles: ['superadmin'] }, {}),
    );
    expect(outcome.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
