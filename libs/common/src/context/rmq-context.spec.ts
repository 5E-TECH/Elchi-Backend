import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { ExecutionContext } from '@nestjs/common';
import { ClientsModule, ClientRMQ, RmqRecord } from '@nestjs/microservices';
import { defer, firstValueFrom, lastValueFrom, of } from 'rxjs';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { RmqModule } from '../rmq/rmq.module';
import {
  AUDIT_CONTEXT_LIMITS,
  RequestContextStore,
  requestContext,
  sanitizeAuditContext,
} from './request-context';
import {
  RMQ_AUDIT_CTX_HEADER,
  RMQ_TRACE_HEADER,
  RequestContextRmqSerializer,
  buildRmqContextHeaders,
} from './rmq-context.serializer';
import { RmqTraceInterceptor } from './rmq-trace.interceptor';

/**
 * f2Ud5tju — IP/qurilma konteksti gateway'dan mikroservislarga RMQ orqali
 * (AMQP sarlavhalari) yetib boradi va `ActivityLogService.log()` uni
 * metadata'ga qo'shadi.
 */
const HTTP_STORE: RequestContextStore = {
  traceId: 'trace-abc',
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome/126.0 Mobile',
  device_id: 'dev-1',
  device_name: 'Telefon · Android · Chrome',
};

function rpcContext(payload: unknown, headers?: Record<string, unknown>) {
  const rmqCtx = {
    getMessage: () => ({ properties: { headers } }),
  };
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({
      getData: () => payload,
      getContext: () => rmqCtx,
    }),
  } as unknown as ExecutionContext;
}

/** Nest `InterceptorsConsumer` kabi: handler `AsyncResource.bind` bilan. */
function handlerSeeing<T>(fn: () => T) {
  return {
    handle: () => defer(AsyncResource.bind(() => of(fn()))),
  };
}

describe('sanitizeAuditContext', () => {
  it('TC4 user_agent 256 belgigacha kesiladi', () => {
    const out = sanitizeAuditContext({ user_agent: 'U'.repeat(1000) });
    expect(out.user_agent).toHaveLength(AUDIT_CONTEXT_LIMITS.user_agent);
    expect(AUDIT_CONTEXT_LIMITS.user_agent).toBe(256);
  });

  it('begona kalit, satr bo`lmagan va bo`sh qiymatlar tashlanadi', () => {
    expect(
      sanitizeAuditContext({
        ip: '  ',
        user_agent: 42,
        device_id: 'd\u0000x',
        secret: 'nope',
      }),
    ).toEqual({ device_id: 'd x' });
    expect(sanitizeAuditContext(null)).toEqual({});
  });
});

describe('RequestContextRmqSerializer (chiquvchi xabar)', () => {
  const serializer = new RequestContextRmqSerializer();

  it('TC2 kontekst yo`q (cron/bot) — paket o`zgarmaydi, sarlavha yo`q', () => {
    const packet = { pattern: { cmd: 'x' }, data: { a: 1 }, id: '1' };
    expect(serializer.serialize(packet)).toBe(packet);
    expect(buildRmqContextHeaders(undefined)).toEqual({});
  });

  it('TC5 HTTP kontekstida trace + audit SARLAVHADA, payload (data) TEGILMAYDI', () => {
    const packet = {
      pattern: { cmd: 'order.sell' },
      data: { id: '7' },
      id: '1',
    };
    const out = requestContext.run(HTTP_STORE, () =>
      serializer.serialize(packet),
    ) as { data: unknown; options: { headers: Record<string, string> } };
    expect(out.data).toEqual({ id: '7' });
    expect(out.options.headers[RMQ_TRACE_HEADER]).toBe('trace-abc');
    expect(JSON.parse(out.options.headers[RMQ_AUDIT_CTX_HEADER])).toEqual({
      ip: '203.0.113.7',
      user_agent: HTTP_STORE.user_agent,
      device_id: 'dev-1',
      device_name: 'Telefon · Android · Chrome',
    });
  });

  it('faqat traceId li kontekst — audit sarlavhasi qo`shilmaydi', () => {
    const out = requestContext.run({ traceId: 't' }, () =>
      serializer.serialize({ pattern: 'x', data: {} }),
    ) as { options: { headers: Record<string, string> } };
    expect(out.options.headers).toEqual({ [RMQ_TRACE_HEADER]: 't' });
  });

  it('RmqRecord (Nest standart xulqi) saqlanadi, uning sarlavhasi USTUN', () => {
    const record = new RmqRecord(
      { id: '7' },
      { headers: { [RMQ_TRACE_HEADER]: 'caller' }, priority: 3 },
    );
    const out = requestContext.run(HTTP_STORE, () =>
      serializer.serialize({ pattern: 'x', data: record }),
    ) as {
      data: unknown;
      options: { priority: number; headers: Record<string, string> };
    };
    expect(out.data).toEqual({ id: '7' });
    expect(out.options.priority).toBe(3);
    expect(out.options.headers[RMQ_TRACE_HEADER]).toBe('caller');
    expect(out.options.headers[RMQ_AUDIT_CTX_HEADER]).toBeDefined();
  });

  it('haqiqiy ClientRMQ.send/emit chaqiruvchi ALS kontekstida serializatsiya qiladi', async () => {
    const sent: Array<{ content: Buffer; options: Record<string, any> }> = [];
    const client = new ClientRMQ({
      urls: ['amqp://unused'],
      queue: 'order_queue',
      serializer,
    });
    const internals = client as unknown as Record<string, unknown>;
    internals.connect = () => Promise.resolve();
    internals.responseEmitter = new EventEmitter();
    internals.channel = {
      sendToQueue: jest.fn(
        (
          _queue: string,
          content: Buffer,
          options: Record<string, any>,
          cb?: (err?: unknown) => void,
        ) => {
          sent.push({ content, options });
          if (cb) cb();
          // RPC: javobni darhol qaytaramiz.
          if (options.correlationId) {
            setImmediate(() =>
              (internals.responseEmitter as EventEmitter).emit(
                options.correlationId,
                {
                  content: Buffer.from(
                    JSON.stringify({ response: 'ok', isDisposed: true }),
                  ),
                  options: {},
                },
              ),
            );
          }
          return Promise.resolve(true);
        },
      ),
    };

    await requestContext.run(HTTP_STORE, async () => {
      await firstValueFrom(client.send({ cmd: 'order.sell' }, { id: '7' }));
      await lastValueFrom(client.emit({ cmd: 'order.event' }, { id: '8' }));
    });
    // Kontekstdan tashqarida — sarlavhasiz.
    await firstValueFrom(client.send({ cmd: 'cron.job' }, { id: '9' }));

    expect(sent).toHaveLength(3);
    expect(sent[0].options.headers[RMQ_TRACE_HEADER]).toBe('trace-abc');
    expect(
      JSON.parse(sent[0].options.headers[RMQ_AUDIT_CTX_HEADER] as string).ip,
    ).toBe('203.0.113.7');
    expect(sent[1].options.headers[RMQ_TRACE_HEADER]).toBe('trace-abc');
    // Payload tanasi o'zgarmagan.
    expect(JSON.parse(sent[0].content.toString()).data).toEqual({ id: '7' });
    expect(sent[2].options.headers).toBeUndefined();
  });
});

describe('RmqTraceInterceptor (kiruvchi xabar)', () => {
  const interceptor = new RmqTraceInterceptor();

  it('TC5 sarlavhadagi trace + IP/qurilma handler kontekstiga tushadi', async () => {
    const headers = requestContext.run(HTTP_STORE, () =>
      buildRmqContextHeaders(),
    );
    const seen = await lastValueFrom(
      interceptor.intercept(
        rpcContext({ id: '7' }, headers),
        handlerSeeing(() => requestContext.get()),
      ),
    );
    expect(seen).toEqual(HTTP_STORE);
  });

  it('payload trace_id (rmqSend) ustun, audit baribir sarlavhadan', async () => {
    const headers = requestContext.run(HTTP_STORE, () =>
      buildRmqContextHeaders(),
    );
    const seen = (await lastValueFrom(
      interceptor.intercept(
        rpcContext({ trace_id: 'from-payload' }, headers),
        handlerSeeing(() => requestContext.get()),
      ),
    )) as RequestContextStore;
    expect(seen.traceId).toBe('from-payload');
    expect(seen.ip).toBe('203.0.113.7');
  });

  it('TC2 sarlavha ham, trace ham yo`q (cron/outbox) — kontekst ochilmaydi', async () => {
    const seen = await lastValueFrom(
      interceptor.intercept(
        rpcContext({ id: '7' }),
        handlerSeeing(() => requestContext.get()),
      ),
    );
    expect(seen).toBeUndefined();
  });

  it('buzuq/uzun sarlavhalar e`tiborsiz qoldiriladi', async () => {
    const seen = await lastValueFrom(
      interceptor.intercept(
        rpcContext(
          {},
          {
            [RMQ_TRACE_HEADER]: Buffer.from('t-1'),
            [RMQ_AUDIT_CTX_HEADER]: '{not json',
          },
        ),
        handlerSeeing(() => requestContext.get()),
      ),
    );
    expect(seen).toEqual({ traceId: 't-1' });

    const tooLong = await lastValueFrom(
      interceptor.intercept(
        rpcContext({}, { [RMQ_TRACE_HEADER]: 'x'.repeat(65) }),
        handlerSeeing(() => requestContext.get()),
      ),
    );
    expect(tooLong).toBeUndefined();
  });

  it('TC5 uchdan-uchga: gateway → (RMQ sarlavha) → order-service log() metadata`sida IP', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const service = new ActivityLogService(
      {
        create: (row: Record<string, unknown>) => row,
        save: (row: Record<string, unknown>) => {
          saved.push(row);
          return Promise.resolve(row);
        },
      } as never,
      'order-service',
    );
    // Gateway tomoni: HTTP kontekstida chiquvchi xabar.
    const outgoing = requestContext.run(HTTP_STORE, () =>
      new RequestContextRmqSerializer().serialize({
        pattern: { cmd: 'order.sell' },
        data: { id: '7' },
      }),
    ) as { data: unknown; options: { headers: Record<string, unknown> } };
    // order-service tomoni: interceptor → handler → log().
    await lastValueFrom(
      interceptor.intercept(
        rpcContext(outgoing.data, outgoing.options.headers),
        {
          handle: () =>
            defer(
              AsyncResource.bind(() =>
                service.log({
                  entity_type: 'Order',
                  entity_id: '7',
                  action: 'order.sell',
                  metadata: { market_id: '501' },
                }),
              ),
            ),
        },
      ),
    );
    expect(saved[0].metadata).toEqual({
      ip: '203.0.113.7',
      user_agent: HTTP_STORE.user_agent,
      device_id: 'dev-1',
      device_name: 'Telefon · Android · Chrome',
      market_id: '501',
    });
    expect(saved[0].trace_id).toBe('trace-abc');
  });
});

describe('RmqModule.register', () => {
  it('har RMQ klientiga kontekst serializer`i ulanadi', () => {
    const spy = jest.spyOn(ClientsModule, 'registerAsync');
    try {
      RmqModule.register({ name: 'ORDER' });
      const [[options]] = spy.mock.calls as unknown as Array<
        [
          Array<{
            useFactory: (c: unknown) => { options: { serializer: unknown } };
          }>,
        ]
      >;
      const config = { get: (k: string) => ({ RABBITMQ_URI: 'amqp://x' })[k] };
      const built = options[0].useFactory(config);
      expect(built.options.serializer).toBeInstanceOf(
        RequestContextRmqSerializer,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
