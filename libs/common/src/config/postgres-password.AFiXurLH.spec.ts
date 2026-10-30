import { identityValidationSchema, orderValidationSchema } from './index';

/**
 * (AFiXurLH) POSTGRES_PASSWORD >= 24 belgi faqat production'da. Barcha servis
 * sxemalari `observabilityKeys` ni yoyadi — ikkitasi tekshiriladi.
 */
describe('POSTGRES_PASSWORD validator (AFiXurLH)', () => {
  const base = (over: Record<string, string>) => ({
    POSTGRES_URI: 'postgres://u:p@localhost:5432/db',
    RABBITMQ_URI: 'amqp://localhost',
    ACCESS_TOKEN_KEY: 'a'.repeat(8) + '9f3c1e7b2d4a6c8e0f1a3b5c7d9e1f2a',
    REFRESH_TOKEN_KEY: 'b'.repeat(8) + '1e2d3c4b5a69788796a5b4c3d2e1f0a9',
    ...over,
  });
  const err = (schema: typeof identityValidationSchema, env: object) =>
    schema
      .validate(env, { allowUnknown: true, abortEarly: false })
      .error?.details.filter((d) => d.path[0] === 'POSTGRES_PASSWORD')
      .map((d) => d.message) ?? [];

  it('production: 23 belgi rad etiladi, xabarda runbook bor', () => {
    const e = err(
      identityValidationSchema,
      base({ NODE_ENV: 'production', POSTGRES_PASSWORD: 'x'.repeat(23) }),
    );
    expect(e.join(' ')).toMatch(/at least 24 characters/);
    expect(e.join(' ')).toMatch(/secret-rotation\.md/);
  });

  it('production: 24 belgi va openssl rand -hex 24 o`tadi', () => {
    for (const POSTGRES_PASSWORD of [
      'x'.repeat(24),
      '3f9c2a7e1b4d6f8a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d',
    ]) {
      expect(
        err(
          identityValidationSchema,
          base({ NODE_ENV: 'production', POSTGRES_PASSWORD }),
        ),
      ).toEqual([]);
    }
  });

  it('production: kalit yo`q bo`lsa servis yiqilmaydi (POSTGRES_URI ishlatiladi)', () => {
    expect(
      err(orderValidationSchema, base({ NODE_ENV: 'production' })),
    ).toEqual([]);
  });

  it('dev/test: qisqa lokal parol boot`ni to`xtatmaydi', () => {
    expect(
      err(
        identityValidationSchema,
        base({ NODE_ENV: 'development', POSTGRES_PASSWORD: 'postgres' }),
      ),
    ).toEqual([]);
    expect(
      err(orderValidationSchema, base({ POSTGRES_PASSWORD: 'postgres' })),
    ).toEqual([]);
  });
});
