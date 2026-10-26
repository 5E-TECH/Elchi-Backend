import { AppLoggerModule, sanitizeLogUrl } from './app-logger.module';

describe('oFfOWGuo — logdagi URL: query yo‘q, token maskalangan', () => {
  it.each([
    ['/search?q=998901234567', '/search'],
    ['/orders?phone=998901234567&page=2', '/orders'],
    ['/sms/stop/9f8e7d6c5b4a', '/sms/stop/***'],
    ['/sms/stop/9f8e7d6c5b4a?utm=1', '/sms/stop/***'],
    ['/scan/POST-20261026-0001', '/scan/***'],
    ['/v1/scan/ORD-123', '/v1/scan/***'],
    ['/orders/qr-code/abc.def', '/orders/qr-code/***'],
    ['/scan/ORD-1/extra', '/scan/***/extra'],
    // kiZgTybn — smena rasmi havolasi (300 s bearer token).
    ['/files/signed/AbC-_123xyz', '/files/signed/***'],
    ['/v1/files/signed/AbC-_123xyz', '/v1/files/signed/***'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeLogUrl(input)).toBe(expected);
  });

  it.each([
    '/orders/123',
    '/health',
    '/scanner/x',
    '/sms/templates',
    '/files/view/products-1.png',
    '/',
  ])('oddiy yo‘l o‘zgarmaydi: %s', (url) => {
    expect(sanitizeLogUrl(url)).toBe(url);
  });

  it('undefined → undefined', () => {
    expect(sanitizeLogUrl(undefined)).toBeUndefined();
  });

  it('⭐ pino `req` serializer shu funksiyadan o‘tadi (barcha servislar)', () => {
    const outer = AppLoggerModule.forRoot({ serviceName: 'spec' });
    const inner = outer.imports![0] as {
      providers: Array<{ provide?: unknown; useValue?: unknown }>;
    };
    const params = inner.providers.find((p) => p.provide === 'pino-params')
      ?.useValue as {
      pinoHttp: { serializers: { req: (req: unknown) => { url?: string } } };
    };
    expect(
      params.pinoHttp.serializers.req({
        id: '1',
        method: 'GET',
        url: '/sms/stop/secret-token?x=1',
      }),
    ).toEqual({ id: '1', method: 'GET', url: '/sms/stop/***' });
  });
});
