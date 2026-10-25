// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import { GATEWAY_CLIENT_TOKENS } from './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of } from 'rxjs';
import { ApiGatewayModule } from '../src/api-gateway.module';

export type GatewayClientToken = (typeof GATEWAY_CLIENT_TOKENS)[number];

export type ClientReply = (
  token: GatewayClientToken,
  pattern: { cmd?: string },
  payload: unknown,
) => Observable<unknown>;

export interface MockClient {
  send: jest.Mock<Observable<unknown>, [{ cmd?: string }, unknown]>;
  emit: jest.Mock<Observable<unknown>, [unknown, unknown]>;
  connect: jest.Mock<Promise<void>, []>;
  close: jest.Mock<Promise<void>, []>;
}

/**
 * (7s1bqOT6) HAQIQIY ApiGatewayModule (barcha kontrollerlar modul tartibida,
 * global guard'lar, throttler) — faqat 14 ta RMQ ClientProxy mock bilan
 * almashtiriladi. RabbitMQ/Postgres kerak emas; marshrut to'qnashuvi kabi
 * HTTP darajasidagi xatolar unit spec'dan farqli o'laroq shu yerda ko'rinadi.
 */
export interface GatewayE2eOptions {
  /** main.ts dagi kabi `rawBody: true` (sukut: yo'q). */
  rawBody?: boolean;
  /** `app.init()` DAN OLDIN — main.ts sozlamalari (pipe, filtr, versiya). */
  configure?: (app: INestApplication) => void;
}

export async function createGatewayE2eApp(
  reply: ClientReply,
  options: GatewayE2eOptions = {},
): Promise<{
  app: INestApplication;
  clients: Map<GatewayClientToken, MockClient>;
}> {
  const clients = new Map<GatewayClientToken, MockClient>();
  let builder = Test.createTestingModule({ imports: [ApiGatewayModule] });
  for (const token of GATEWAY_CLIENT_TOKENS) {
    const client: MockClient = {
      send: jest.fn((pattern: { cmd?: string }, payload: unknown) =>
        reply(token, pattern, payload),
      ),
      emit: jest.fn(() => of(undefined)),
      connect: jest.fn(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve()),
    };
    clients.set(token, client);
    builder = builder.overrideProvider(token).useValue(client);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({
    logger: false,
    ...(options.rawBody ? { rawBody: true } : {}),
  });
  options.configure?.(app);
  await app.init();
  return { app, clients };
}
