import { metricsAccess } from './metrics';

describe('oFfOWGuo — /metrics kirish qoidasi (metricsAccess)', () => {
  const TOKEN = 'a'.repeat(32) + 'Z9';
  const prod = (extra: Record<string, string> = {}) =>
    ({ NODE_ENV: 'production', ...extra }) as NodeJS.ProcessEnv;

  it('⭐ production, token yo‘q → disabled (404)', () => {
    expect(metricsAccess(undefined, prod())).toBe('disabled');
    expect(metricsAccess(`Bearer ${TOKEN}`, prod())).toBe('disabled');
    expect(metricsAccess(undefined, prod({ METRICS_TOKEN: '  ' }))).toBe(
      'disabled',
    );
  });

  it('dev/test, token yo‘q → ochiq (avvalgidek)', () => {
    expect(metricsAccess(undefined, { NODE_ENV: 'development' })).toBe('allow');
    expect(metricsAccess(undefined, {})).toBe('allow');
  });

  it('⭐ token bor → faqat to‘g‘ri Bearer', () => {
    const env = prod({ METRICS_TOKEN: TOKEN });
    expect(metricsAccess(`Bearer ${TOKEN}`, env)).toBe('allow');
    expect(metricsAccess(`bearer ${TOKEN}`, env)).toBe('allow');
    expect(metricsAccess([`Bearer ${TOKEN}`], env)).toBe('allow');
    expect(metricsAccess(undefined, env)).toBe('unauthorized');
    expect(metricsAccess(TOKEN, env)).toBe('unauthorized');
    expect(metricsAccess(`Bearer ${TOKEN.slice(1)}`, env)).toBe('unauthorized');
    expect(metricsAccess(`Basic ${TOKEN}`, env)).toBe('unauthorized');
    // dev'da ham token bor bo'lsa — talab qilinadi.
    expect(
      metricsAccess(undefined, {
        NODE_ENV: 'development',
        METRICS_TOKEN: TOKEN,
      }),
    ).toBe('unauthorized');
  });
});
