import { scrubSentryEvent } from './scrub-pii';
import { scrubLogArgs, PINO_REDACT_PATHS } from '../logger/app-logger.module';

/** be-brief §7: Sentry va pino'da Anthropic kaliti QIYMAT bo'yicha tozalanadi. */
const KEY = 'sk-ant-api03-' + 'x'.repeat(40);

describe('Sentry: AI kalit tozalash', () => {
  it('/ai/config va /auth/step-up — request.data olib tashlanadi', () => {
    for (const url of [
      'https://api/ai/config/key',
      'https://api/v1/ai/config/key/restore-previous',
      'https://api/ai/config',
      'https://api/v1/auth/step-up',
      'https://api/ai/config?x=1',
    ]) {
      const out = scrubSentryEvent({
        request: { url, data: { key_envelope: { ct: 'abc' }, password: 'p' } },
      });
      expect(out.request).not.toHaveProperty('data');
    }
    const other = scrubSentryEvent({
      request: { url: 'https://api/ai/configs', data: { a: 1 } },
    });
    expect(other.request?.data).toEqual({ a: 1 });
  });

  it('message, logentry, exception, extra, contexts, breadcrumbs, request.data', () => {
    const out = scrubSentryEvent({
      message: `x ${KEY}`,
      logentry: { message: `y ${KEY}` },
      exception: { values: [{ value: `401 ${KEY}` }] },
      extra: { deep: { deeper: [KEY] }, s: KEY },
      contexts: { anthropic: { key: KEY } },
      breadcrumbs: [{ message: KEY, data: { k: { v: KEY } } }],
      request: { url: 'https://api/orders/1', data: { note: KEY } },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.message).toBe('x sk-ant-[REDACTED]');
  });

  it('kalitsiz event o‘zgarmaydi (telefon maskasi saqlanadi)', () => {
    const out = scrubSentryEvent({ message: 'hello', extra: { n: 1 } });
    expect(out).toEqual({ message: 'hello', extra: { n: 1 } });
  });
});

describe('pino: AI kalit tozalash', () => {
  it('redact yo‘llari: api_key, secret_enc, key_envelope', () => {
    for (const p of [
      'api_key',
      '*.api_key',
      '*.*.api_key',
      'secret_enc',
      '*.secret_enc',
      '*.*.secret_enc',
      'key_envelope',
      '*.key_envelope',
    ]) {
      expect(PINO_REDACT_PATHS).toContain(p);
    }
  });

  it('logMethod argumentlari: chuqur va xato matni', () => {
    const err = new Error(`Anthropic 401 ${KEY}`);
    const args = [{ a: { b: { c: { d: KEY } } }, err }, `msg ${KEY}`];
    const out = scrubLogArgs(args);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(String((out[0] as { err: Error }).err.stack)).not.toContain(KEY);
    expect(out[1]).toBe('msg sk-ant-[REDACTED]');
  });

  it('kalitsiz argumentlar — aynan o‘sha massiv', () => {
    const args = [{ a: 1 }, 'x'];
    expect(scrubLogArgs(args)).toBe(args);
  });
});
