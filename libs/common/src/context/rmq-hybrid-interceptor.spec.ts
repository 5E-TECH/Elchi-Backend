import 'reflect-metadata';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CustomTransportStrategy,
  MessagePattern,
  Payload,
  RmqContext,
  Server,
} from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { RmqTraceInterceptor } from './rmq-trace.interceptor';
import { requestContext } from './request-context';
import {
  RMQ_AUDIT_CTX_HEADER,
  RMQ_TRACE_HEADER,
} from './rmq-context.serializer';

/**
 * (f2Ud5tju) PROD'DA TOPILGAN XATO: servislar hybrid app (HTTP + RMQ) va
 * `app.useGlobalInterceptors(new RmqTraceInterceptor())` faqat HTTP'ga
 * qo'llanardi — `connectMicroservice` `inheritAppConfig` siz yangi, bo'sh
 * config oladi. Natijada activity_logs da trace_id / ip / qurilma HECH
 * QACHON yozilmagan (unit spec'lar interceptor'ni to'g'ridan-to'g'ri
 * chaqirgani uchun buni ushlamagan). Bu spec HAQIQIY Nest hybrid
 * bootstrap'ini ishlatadi.
 */
class CapturingServer extends Server implements CustomTransportStrategy {
  listen(callback: () => void) {
    callback();
  }
  close() {}
  on() {
    return this;
  }
  unwrap<T>(): T {
    return undefined as T;
  }
  call(pattern: string, data: unknown, ctx: RmqContext) {
    const handler = this.getHandlerByPattern(pattern);
    if (!handler) throw new Error(`handler yo'q: ${pattern}`);
    return handler(data, ctx);
  }
}

class StrictDto {
  id!: string;
}

@Controller()
class ProbeController {
  @MessagePattern({ cmd: 'probe.context' })
  probe() {
    return requestContext.get() ?? null;
  }

  @MessagePattern({ cmd: 'probe.payload' })
  payload(@Payload() data: StrictDto) {
    return data;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const rmqContext = (headers: Record<string, unknown>) =>
  new RmqContext([
    { properties: { headers }, content: Buffer.from('') },
    {},
    '',
  ]);

async function resolve(result: unknown): Promise<unknown> {
  const value = await result;
  if (
    value &&
    typeof (value as { subscribe?: unknown }).subscribe === 'function'
  ) {
    return lastValueFrom(value as never);
  }
  return value;
}

async function boot(inherit: boolean) {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  const server = new CapturingServer();
  app.connectMicroservice(
    { strategy: server },
    inherit ? { inheritAppConfig: true } : {},
  );
  // identity/investor naqshi: ValidationPipe connectMicroservice'dan KEYIN.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.startAllMicroservices();
  return { app, server };
}

describe('RmqTraceInterceptor — hybrid app (f2Ud5tju prod regressiyasi)', () => {
  const headers = {
    [RMQ_TRACE_HEADER]: 'trace-prod-1',
    [RMQ_AUDIT_CTX_HEADER]: JSON.stringify({
      ip: '203.0.113.7',
      device_name: 'Telefon · Android · Chrome',
    }),
  };

  it('inheritAppConfig BILAN: RMQ handler kontekstni (trace + ip) ko`radi', async () => {
    const { app, server } = await boot(true);
    try {
      const ctx = await resolve(
        server.call(
          JSON.stringify({ cmd: 'probe.context' }),
          {},
          rmqContext(headers),
        ),
      );
      expect(ctx).toMatchObject({
        traceId: 'trace-prod-1',
        ip: '203.0.113.7',
        device_name: 'Telefon · Android · Chrome',
      });
    } finally {
      await app.close();
    }
  });

  it('inheritAppConfig SIZ (eski holat): kontekst yo`q — xato shu edi', async () => {
    const { app, server } = await boot(false);
    try {
      const ctx = await resolve(
        server.call(
          JSON.stringify({ cmd: 'probe.context' }),
          {},
          rmqContext(headers),
        ),
      );
      expect(ctx).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keyin qo`shilgan ValidationPipe RMQ payload`iga QO`LLANMAYDI (xulq o`zgarmagan)', async () => {
    const { app, server } = await boot(true);
    try {
      const data = await resolve(
        server.call(
          JSON.stringify({ cmd: 'probe.payload' }),
          { id: '1', extra: 'whitelist-da-yo`q' },
          rmqContext({}),
        ),
      );
      expect(data).toEqual({ id: '1', extra: 'whitelist-da-yo`q' });
    } finally {
      await app.close();
    }
  });
});

describe('servis main.ts — RMQ interceptor meros qilib olinadi', () => {
  const appsDir = join(__dirname, '../../../../apps');
  const mains = readdirSync(appsDir)
    .map((name) => join(appsDir, name, 'src/main.ts'))
    .filter((file) => existsSync(file));

  it.each(
    mains.filter((f) =>
      readFileSync(f, 'utf8').includes('new RmqTraceInterceptor()'),
    ),
  )('%s: connectMicroservice inheritAppConfig: true bilan', (file) => {
    const src = readFileSync(file, 'utf8');
    const calls = src.match(/app\.connectMicroservice\([\s\S]*?\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('inheritAppConfig: true');
    }
    // Global pipe connectMicroservice'dan OLDIN bo'lsa — RMQ'ga yangi
    // qo'llanib, payload'larni sindirardi.
    const pipeAt = src.indexOf('app.useGlobalPipes(');
    if (pipeAt >= 0) {
      expect(pipeAt).toBeGreaterThan(src.indexOf('app.connectMicroservice('));
    }
  });
});
