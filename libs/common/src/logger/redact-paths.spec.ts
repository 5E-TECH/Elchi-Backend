import type { DynamicModule, Provider, ValueProvider } from '@nestjs/common';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import pino from 'pino';
import { AppLoggerModule, PINO_REDACT_PATHS } from './app-logger.module';

/** HD5zOyBp #18: AI buyurtma PII kalitlari logga chiqmaydi. */
const AI_ORDER_PII_PATHS = [
  '*.phone_number',
  '*.extra_number',
  '*.address',
  '*.full_address',
  '*.customer_name',
  '*.data_base64',
  '*.file_base64',
  '*.images',
  '*.raw_orders',
  '*.previews',
];

function logThrough(obj: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: [...PINO_REDACT_PATHS], censor: '[REDACTED]' } },
    { write: (chunk: string) => lines.push(chunk) },
  );
  logger.info(obj, 'ai order');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe('PINO_REDACT_PATHS', () => {
  it('AI buyurtma PII yo‘llarini (bir daraja ichki) o‘z ichiga oladi', () => {
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining(AI_ORDER_PII_PATHS),
    );
  });

  it('avvalgi sirlar/PII yo‘llari saqlangan', () => {
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        '*.token',
        '*.api_key',
        '*.pinfl',
        '*.card_number',
        '*.phone_number',
      ]),
    );
  });

  it('nestjs-logger `logger.log({ ... })` yuqori darajaga yoyadi — yuqori darajadagi kalitlar ham bor', () => {
    for (const path of AI_ORDER_PII_PATHS) {
      expect(PINO_REDACT_PATHS).toContain(path.slice(2));
    }
  });

  it('AppLoggerModule.forRoot aynan shu ro‘yxatni pino-http redact’ga beradi', () => {
    const dynamic = AppLoggerModule.forRoot({ serviceName: 'ai-service' });
    const loggerModule = dynamic.imports?.[0] as DynamicModule;
    const paramsProvider = (loggerModule.providers ?? []).find(
      (p: Provider): p is ValueProvider<Params> =>
        typeof p === 'object' &&
        'provide' in p &&
        p.provide === PARAMS_PROVIDER_TOKEN,
    );
    const pinoHttp = paramsProvider?.useValue.pinoHttp as {
      redact: { paths: string[]; censor: string };
    };

    expect(pinoHttp.redact.paths).toEqual([...PINO_REDACT_PATHS]);
    expect(pinoHttp.redact.censor).toBe('[REDACTED]');
  });

  it('haqiqiy pino: ichki va yuqori darajadagi PII [REDACTED] bo‘ladi', () => {
    const line = logThrough({
      phone_number: '+998901234567',
      customer_name: 'Aziz',
      market_id: '12',
      order: {
        phone_number: '+998901234567',
        extra_number: '+998912345678',
        address: 'Chilonzor 5-uy',
        full_address: 'Toshkent shahri Chilonzor 5-uy',
        customer_name: 'Aziz',
        total_price: 320000,
      },
      request: {
        images: [{ media_type: 'image/jpeg', data_base64: '/9j/4AAQ' }],
        file_base64: '/9j/4AAQ',
      },
      result: { raw_orders: [{ phone_number: '+998901234567' }] },
      preview: { previews: [{ customer_name: 'Aziz' }] },
      image: { data_base64: '/9j/4AAQ' },
    });

    expect(line).toMatchObject({
      phone_number: '[REDACTED]',
      customer_name: '[REDACTED]',
      market_id: '12',
      order: {
        phone_number: '[REDACTED]',
        extra_number: '[REDACTED]',
        address: '[REDACTED]',
        full_address: '[REDACTED]',
        customer_name: '[REDACTED]',
        total_price: 320000,
      },
      request: { images: '[REDACTED]', file_base64: '[REDACTED]' },
      result: { raw_orders: '[REDACTED]' },
      preview: { previews: '[REDACTED]' },
      image: { data_base64: '[REDACTED]' },
    });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('901234567');
    expect(serialized).not.toContain('Chilonzor');
    expect(serialized).not.toContain('/9j/');
  });
});
