import { AsyncResource } from 'node:async_hooks';
import { ExecutionContext } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { defer, of } from 'rxjs';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  RequestContextStore,
  requestContext,
} from '../context/request-context';
import { RequestContextRmqSerializer } from '../context/rmq-context.serializer';
import { RmqTraceInterceptor } from '../context/rmq-trace.interceptor';
import {
  OUTBOX_CONTEXT_KEY,
  attachOutboxContext,
  splitOutboxContext,
} from './outbox-context';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxService } from './outbox.service';

/**
 * LQWRBwXA — outbox orqali o'tadigan hodisa ham trace'ni (va IP/aktyorni)
 * olib o'tadi: "buyurtma → (outbox) → moliya" zanjirida ikkala jurnal
 * qatorida AYNI trace_id. Ichki kalit handler'ga YUBORILMAYDI.
 */
const HTTP: RequestContextStore = {
  traceId: 'trace-ob-1',
  ip: '203.0.113.9',
  device_id: 'dev-9',
  userId: '1',
  userName: 'Dilshod',
  userRole: 'superadmin',
};

function makeOutboxService() {
  const saved: Array<Record<string, unknown>> = [];
  const repo = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => {
      saved.push(row);
      return Promise.resolve(row);
    }),
    find: jest.fn(() =>
      Promise.resolve(
        saved
          .filter((r) => r.status === 'pending')
          .map((r, i) => ({ id: String(i + 1), attempts: 0, ...r })),
      ),
    ),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    findOne: jest.fn(() => Promise.resolve(null)),
  };
  return { outbox: new OutboxService(repo as never), saved, repo };
}

function makePublisher(
  outbox: OutboxService,
  clients: Record<string, { send: jest.Mock }>,
) {
  const publisher = new OutboxPublisher(
    {} as ModuleRef,
    outbox,
    Object.keys(clients),
    { fireAndForgetPatterns: [] } as never,
  );
  const internals = publisher as unknown as {
    clients: Map<string, unknown>;
    tick: () => Promise<void>;
  };
  for (const [t, c] of Object.entries(clients)) internals.clients.set(t, c);
  return internals;
}

describe('attachOutboxContext / splitOutboxContext', () => {
  it('kontekst bo`lmasa (cron/bot) payload o`zgarmaydi', () => {
    const p = { a: 1 };
    expect(attachOutboxContext(p, undefined)).toBe(p);
  });

  it('kontekstda: trace + IP/qurilma + aktyor ichki kalitga; split asl payload`ni qaytaradi', () => {
    const withCtx = attachOutboxContext({ a: 1, request_id: 'r' }, HTTP);
    expect(withCtx).toEqual({
      a: 1,
      request_id: 'r',
      [OUTBOX_CONTEXT_KEY]: {
        traceId: 'trace-ob-1',
        ip: '203.0.113.9',
        device_id: 'dev-9',
        userId: '1',
        userName: 'Dilshod',
        userRole: 'superadmin',
      },
    });
    expect(splitOutboxContext(withCtx)).toEqual({
      payload: { a: 1, request_id: 'r' },
      store: HTTP,
    });
  });

  it('buzuq ichki kalit — kontekst tiklanmaydi, lekin kalit baribir olib tashlanadi', () => {
    expect(
      splitOutboxContext({ a: 1, [OUTBOX_CONTEXT_KEY]: { traceId: 'x y' } }),
    ).toEqual({ payload: { a: 1 }, store: null });
    expect(splitOutboxContext([1, 2])).toEqual({
      payload: [1, 2],
      store: null,
    });
  });
});

describe('LQWRBwXA — outbox orqali trace_id', () => {
  it('⭐ enqueue HTTP kontekstida — kontekst saqlanadi; kontekstsiz — payload avvalgidek', async () => {
    const { outbox, saved } = makeOutboxService();
    await requestContext.run({ ...HTTP }, () =>
      outbox.enqueue('FINANCE', 'finance.cashbox.income', { amount: 5 }),
    );
    await outbox.enqueue('FINANCE', 'finance.cashbox.income', { amount: 6 });

    expect(
      (saved[0].payload as Record<string, unknown>)[OUTBOX_CONTEXT_KEY],
    ).toEqual(expect.objectContaining({ traceId: 'trace-ob-1' }));
    expect(saved[1].payload).toEqual({
      amount: 6,
      request_id: expect.any(String),
    });
  });

  it('⭐ uchdan-uchga: order (HTTP) → outbox → relay (kontekstsiz tick) → finance log() — AYNI trace_id, aktyor, handler ichki kalitni ko`rmaydi', async () => {
    const { outbox } = makeOutboxService();
    const savedLogs: Array<Record<string, unknown>> = [];
    const finance = new ActivityLogService(
      {
        create: (r: Record<string, unknown>) => r,
        save: (r: Record<string, unknown>) => {
          savedLogs.push(r);
          return Promise.resolve(r);
        },
      } as never,
      'finance-service',
    );
    const serializer = new RequestContextRmqSerializer();
    const interceptor = new RmqTraceInterceptor();
    let handlerData: unknown;

    // FINANCE klienti: haqiqiy serializer → sarlavhalar → interceptor → handler.
    const financeClient = {
      send: jest.fn((pattern: unknown, data: unknown) => {
        const packet = serializer.serialize({ pattern, data }) as {
          data: unknown;
          options?: { headers?: Record<string, unknown> };
        };
        const rpc = {
          getType: () => 'rpc',
          switchToRpc: () => ({
            getData: () => packet.data,
            getContext: () => ({
              getMessage: () => ({
                properties: { headers: packet.options?.headers },
              }),
            }),
          }),
        } as unknown as ExecutionContext;
        return interceptor.intercept(rpc, {
          handle: () =>
            defer(
              AsyncResource.bind(async () => {
                handlerData = packet.data;
                await finance.log({
                  entity_type: 'Cashbox',
                  entity_id: '3',
                  action: 'finance.manual_income',
                });
                return of({ ok: true });
              }),
            ),
        });
      }),
    };

    // order-service: HTTP so'rovi ichida biznes yozuvi + outbox.
    await requestContext.run({ ...HTTP }, () =>
      outbox.enqueue('FINANCE', 'finance.cashbox.income', { amount: 150000 }),
    );
    // Relay — KONTEKSTSIZ (cron tick).
    expect(requestContext.get()).toBeUndefined();
    await makePublisher(outbox, { FINANCE: financeClient }).tick();

    expect(financeClient.send).toHaveBeenCalledTimes(1);
    expect(handlerData).toEqual({
      amount: 150000,
      request_id: expect.any(String),
    });
    expect(savedLogs[0]).toMatchObject({
      trace_id: 'trace-ob-1',
      user_id: '1',
      user_name: 'Dilshod',
      user_role: 'superadmin',
    });
    expect(savedLogs[0].metadata).toEqual({
      ip: '203.0.113.9',
      device_id: 'dev-9',
    });
  });

  it('kontekstsiz yozilgan eski hodisa — avvalgidek (sarlavhasiz) yuboriladi', async () => {
    const { outbox } = makeOutboxService();
    const seen: unknown[] = [];
    const client = {
      send: jest.fn((_p: unknown, data: unknown) => {
        seen.push([data, requestContext.get()]);
        return of({ ok: true });
      }),
    };
    await outbox.enqueue('FINANCE', 'finance.x', { a: 1 });
    await makePublisher(outbox, { FINANCE: client }).tick();
    expect(seen).toEqual([
      [{ a: 1, request_id: expect.any(String) }, undefined],
    ]);
  });
});
