import { AsyncResource } from 'node:async_hooks';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { RequestContextStore, requestContext } from './request-context';
import {
  RMQ_AUDIT_ACTOR_HEADER,
  RMQ_TRACE_HEADER,
  RequestContextRmqSerializer,
  buildRmqContextHeaders,
} from './rmq-context.serializer';
import { RmqTraceInterceptor } from './rmq-trace.interceptor';

/**
 * fQi6NNUL / y8CxCtcK — aktyor (id/ism/rol) gateway'dan RMQ sarlavhasi
 * (`x-audit-actor`) orqali servislarga boradi va `ActivityLogService.log()`
 * `user_name`/`user_role` ni o'zi to'ldiradi (enrichment'siz ham ism bor).
 *
 * LQWRBwXA — trace_id bir HTTP amali bo'ylab 2+ servisda AYNI; serializer
 * har payload shaklida (obyekt/massiv/primitiv/null) sarlavha qo'shadi;
 * RMQ klienti serializer'siz yaratilsa — test yiqiladi.
 */

const GATEWAY_STORE = (): RequestContextStore => ({
  traceId: 'trace-777',
  ip: '203.0.113.9',
});

function rpcContext(payload: unknown, headers?: Record<string, unknown>) {
  const rmqCtx = { getMessage: () => ({ properties: { headers } }) };
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({
      getData: () => payload,
      getContext: () => rmqCtx,
    }),
  } as unknown as ExecutionContext;
}

function memoryLogService(serviceName: string) {
  const saved: Array<Record<string, unknown>> = [];
  const service = new ActivityLogService(
    {
      create: (row: Record<string, unknown>) => row,
      save: (row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve(row);
      },
    } as never,
    serviceName,
  );
  return { service, saved };
}

/** Gateway tomoni: HTTP konteksti + JWT'dan keyin aktyor. */
function gatewaySend(
  data: unknown,
  actor?: Parameters<typeof requestContext.setActor>[0],
) {
  return requestContext.run(GATEWAY_STORE(), () => {
    if (actor) requestContext.setActor(actor);
    return new RequestContextRmqSerializer().serialize({
      pattern: { cmd: 'x' },
      data,
    });
  }) as { data: unknown; options?: { headers: Record<string, unknown> } };
}

/** Servis tomoni: interceptor → handler (AsyncResource.bind, Nest kabi). */
function receive<T>(
  packet: { data: unknown; options?: { headers: Record<string, unknown> } },
  handler: () => Promise<T> | T,
): Promise<T> {
  return lastValueFrom(
    new RmqTraceInterceptor().intercept(
      rpcContext(packet.data, packet.options?.headers),
      {
        handle: () =>
          defer(AsyncResource.bind(() => Promise.resolve(handler()))),
      },
    ),
  ) as Promise<T>;
}

describe('fQi6NNUL — aktyor ismi/roli kontekstdan (enrichment`siz)', () => {
  it.each(['finance-service', 'order-service', 'logistics-service'])(
    '⭐ %s yozgan yangi qatorda user_name / user_role NOT NULL',
    async (svcName) => {
      const { service, saved } = memoryLogService(svcName);
      const packet = gatewaySend(
        { id: '7' },
        { userId: '1', userName: 'Dilshod', userRole: 'superadmin' },
      );
      await receive(packet, () =>
        service.log({
          entity_type: 'Cashbox',
          entity_id: '3',
          action: 'finance.manual_expense',
        }),
      );
      expect(saved[0]).toMatchObject({
        user_id: '1',
        user_name: 'Dilshod',
        user_role: 'superadmin',
        trace_id: 'trace-777',
      });
      // Aktyor metadata'ga TUSHMAYDI (faqat ip/qurilma).
      expect(saved[0].metadata).toEqual({ ip: '203.0.113.9' });
    },
  );

  it('chaqiruvchi user_id ni aniq bersa (o`sha aktyor) — ism kontekstdan', async () => {
    const { service, saved } = memoryLogService('order-service');
    const packet = gatewaySend(
      {},
      { userId: '42', userName: 'Ali', userRole: 'manager' },
    );
    await receive(packet, () =>
      service.log({
        entity_type: 'Order',
        entity_id: '9',
        action: 'order.sell',
        user_id: '42',
      }),
    );
    expect(saved[0]).toMatchObject({ user_name: 'Ali', user_role: 'manager' });
  });

  it('BOSHQA user_id li qatorga so`rov egasining ismi yopishtirilmaydi', async () => {
    const { service, saved } = memoryLogService('identity-service');
    const packet = gatewaySend(
      {},
      { userId: '42', userName: 'Ali', userRole: 'manager' },
    );
    await receive(packet, () =>
      service.log({
        entity_type: 'User',
        entity_id: '77',
        action: 'updated',
        user_id: '77',
      }),
    );
    expect(saved[0]).toMatchObject({
      user_id: '77',
      user_name: null,
      user_role: null,
    });
  });

  it('chaqiruvchi bergan user_name / user_role USTUN (identity login kabi)', async () => {
    const { service, saved } = memoryLogService('identity-service');
    const packet = gatewaySend(
      {},
      { userId: '1', userName: 'Eski ism', userRole: 'admin' },
    );
    await receive(packet, () =>
      service.log({
        entity_type: 'Auth',
        entity_id: '1',
        action: 'login',
        user_id: '1',
        user_name: 'Dilshod',
        user_role: 'superadmin',
      }),
    );
    expect(saved[0]).toMatchObject({
      user_name: 'Dilshod',
      user_role: 'superadmin',
    });
  });

  it('JWT bo`lmagan oqim (cron/outbox) — aktyor yo`q, avvalgidek NULL', async () => {
    const { service, saved } = memoryLogService('finance-service');
    await service.log({ entity_type: 'X', entity_id: '1', action: 'created' });
    expect(saved[0]).toMatchObject({
      user_id: null,
      user_name: null,
      user_role: null,
      trace_id: null,
    });
  });

  it('aktyor sarlavhasi tozalanadi: buzuq JSON / id`siz / yaroqsiz id tashlanadi', async () => {
    const seen = async (raw: string) =>
      receive(
        {
          data: {},
          options: {
            headers: {
              [RMQ_TRACE_HEADER]: 't-1',
              [RMQ_AUDIT_ACTOR_HEADER]: raw,
            },
          },
        },
        () => requestContext.get(),
      );
    expect(await seen('{bad')).toEqual({ traceId: 't-1' });
    expect(await seen(JSON.stringify({ userName: 'X' }))).toEqual({
      traceId: 't-1',
    });
    expect(
      await seen(JSON.stringify({ userId: '1; DROP', userName: 'X' })),
    ).toEqual({ traceId: 't-1' });
    expect(
      await seen(
        JSON.stringify({
          userId: '5',
          userName: `A\u0000${'b'.repeat(300)}`,
          userRole: 'SUPERADMIN',
        }),
      ),
    ).toEqual({
      traceId: 't-1',
      userId: '5',
      userName: `A ${'b'.repeat(198)}`,
      userRole: 'superadmin',
    });
  });

  it('aktyor bo`lmasa sarlavha qo`shilmaydi (faqat trace/audit)', () => {
    const headers = requestContext.run(GATEWAY_STORE(), () =>
      buildRmqContextHeaders(),
    );
    expect(headers[RMQ_AUDIT_ACTOR_HEADER]).toBeUndefined();
    expect(headers[RMQ_TRACE_HEADER]).toBe('trace-777');
  });
});

describe('LQWRBwXA — trace_id RMQ chegarasidan o`tadi', () => {
  it('⭐ bitta HTTP amali: gateway → order-service → finance-service — ikkala qatorda AYNI trace_id', async () => {
    const order = memoryLogService('order-service');
    const finance = memoryLogService('finance-service');
    const serializer = new RequestContextRmqSerializer();

    // Gateway: xom `client.send` — serializer kontekstni sarlavhaga qo'yadi.
    const toOrder = gatewaySend({ order_id: '100439' }, { userId: '1' });

    await receive(toOrder, async () => {
      await order.service.log({
        entity_type: 'Order',
        entity_id: '100439',
        action: 'order.sell',
      });
      // order-service ichidan finance'ga (servis→servis) — AYNI serializer.
      const toFinance = serializer.serialize({
        pattern: { cmd: 'finance.cashbox.income' },
        data: { amount: 150000 },
      }) as {
        data: unknown;
        options: { headers: Record<string, unknown> };
      };
      await receive(toFinance, () =>
        finance.service.log({
          entity_type: 'Cashbox',
          entity_id: '3',
          action: 'finance.manual_income',
        }),
      );
    });

    expect(order.saved[0].trace_id).toBe('trace-777');
    expect(finance.saved[0].trace_id).toBe('trace-777');
    expect(finance.saved[0].user_id).toBe('1');
  });

  it.each([
    ['massiv', [1, 2, 3]],
    ['primitiv son', 42],
    ['satr', 'abc'],
    ['null', null],
    ['obyekt', { a: 1 }],
  ])(
    '⭐ serializer: dto %s bo`lsa ham trace sarlavhada, payload o`zgarmaydi',
    (_label, data) => {
      const out = gatewaySend(data);
      expect(out.data).toEqual(data);
      expect(out.options?.headers[RMQ_TRACE_HEADER]).toBe('trace-777');
    },
  );

  it('⭐ regressiya: RMQ klienti FAQAT RmqModule.register (serializer bilan) orqali yaratiladi', () => {
    // Xom `client.send(...)` xavfsiz — trace sarlavhasini klientning
    // serializer'i qo'shadi. Xavf faqat serializer'siz yangi klient: shuni
    // qulflaymiz (gateway va servislardagi har qanday yangi marshrut).
    const root = join(__dirname, '..', '..', '..', '..');
    const allowed = new Set(['libs/common/src/rmq/rmq.module.ts']);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          return name === 'node_modules' || name === 'dist' ? [] : walk(full);
        }
        return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
      });
    const files = [...walk(join(root, 'apps')), ...walk(join(root, 'libs'))];
    expect(files.length).toBeGreaterThan(200); // test soxta emas
    const offenders = files
      .map((f) => relative(root, f).split('\\').join('/'))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) =>
        /ClientsModule\.register(?:Async)?\s*\(|ClientProxyFactory\.create\s*\(|new\s+ClientRMQ\s*\(/.test(
          readFileSync(join(root, rel), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
