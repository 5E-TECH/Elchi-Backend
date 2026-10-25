// ⚠️ Birinchi: harness env'ni ApiGatewayModule import qilinishidan OLDIN qo'yadi.
import {
  createGatewayE2eApp,
  type GatewayClientToken,
  type MockClient,
} from '../../test/gateway-e2e.app';
import {
  INestApplication,
  Logger,
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { CSP_REPORT_BODY_LIMIT_BYTES } from './csp-report';

/**
 * KwodkKWY — `POST /csp-report` (HAQIQIY ApiGatewayModule: global JWT
 * default-deny + ClientIpThrottlerGuard; main.ts dagi rawBody, ValidationPipe,
 * filtrlar va URI versiyalash bilan). RMQ mijozlari mock — chaqirilmasligi
 * kerak.
 *
 *  - JWT'siz qabul qilinadi; `application/csp-report` va
 *    `application/reports+json` — 204, javob tanasi BO'SH;
 *  - har buzilish — bitta tuzilmali log qatori (`event: csp_violation`),
 *    URL'lar query'siz;
 *  - boshqa Content-Type — 415, > 32 KB — 413, buzuq JSON — 400; hech birida
 *    kiritilgan matn javobga qaytmaydi;
 *  - per-IP 30/daqiqa — 31-so'rov 429 (boshqa IP'ga ta'sir yo'q).
 */
describe('KwodkKWY — POST /csp-report (gateway, e2e)', () => {
  let app: INestApplication;
  let clients: Map<GatewayClientToken, MockClient>;
  let warn: jest.SpyInstance;
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  let ipSeq = 0;
  /** Har testga alohida IP — throttler hisoblagichlari aralashmasin. */
  const nextIp = () => `203.0.113.${++ipSeq}`;

  const LEGACY = {
    'csp-report': {
      'document-uri': 'https://elchipochta.uz/orders?phone=998901234567',
      referrer: '',
      'violated-directive': 'img-src',
      'effective-directive': 'img-src',
      'original-policy': "default-src 'self'; img-src 'self' data:",
      disposition: 'report',
      'blocked-uri': 'https://api.qrserver.com/v1/create-qr-code/?data=7001',
      'status-code': 200,
      'script-sample': '',
    },
  };

  const cspLogs = () =>
    warn.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          entry.event === 'csp_violation',
      );

  beforeAll(async () => {
    ({ app, clients } = await createGatewayE2eApp(
      () => throwError(() => new Error('RMQ chaqirilmasligi kerak')),
      {
        rawBody: true,
        configure: (nest) => {
          nest.enableVersioning({
            type: VersioningType.URI,
            defaultVersion: [VERSION_NEUTRAL, '1'],
          });
          nest.useGlobalPipes(
            new ValidationPipe({
              whitelist: true,
              forbidNonWhitelisted: true,
              transform: true,
            }),
          );
          nest.useGlobalFilters(
            new AllExceptionsFilter(),
            new RpcExceptionFilter(),
          );
        },
      },
    ));
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    // RMQ'ga hech narsa ketmaydi (`ai.status` — AiStatusPoller'ning o'z
    // fon so'rovi, marshrutga aloqasi yo'q).
    for (const client of clients.values()) {
      const sent = client.send.mock.calls.filter(
        ([pattern]) => pattern.cmd !== 'ai.status',
      );
      expect(sent).toEqual([]);
      expect(client.emit).not.toHaveBeenCalled();
    }
  });

  it('⭐ report-uri: JWT’siz, application/csp-report → 204, bo‘sh javob, tuzilmali log (query’siz)', async () => {
    const res = await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .set('User-Agent', 'Mozilla/5.0 (CSP test)')
      .send(JSON.stringify(LEGACY))
      .expect(204);
    expect(res.text).toBe('');

    const logs = cspLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      msg: 'CSP violation',
      event: 'csp_violation',
      format: 'report-uri',
      document_uri: 'https://elchipochta.uz/orders',
      referrer: null,
      blocked_uri: 'https://api.qrserver.com/v1/create-qr-code/',
      effective_directive: 'img-src',
      violated_directive: 'img-src',
      disposition: 'report',
      source_file: null,
      line_number: null,
      column_number: null,
      status_code: 200,
      sample: null,
      count: 1,
      user_agent: 'Mozilla/5.0 (CSP test)',
      ip: `203.0.113.${ipSeq}`,
    });
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('998901234567');
    expect(logged).not.toContain('data=7001');
    expect(logged).not.toContain('original');
  });

  it('⭐ report-to: application/reports+json massiv → 204; faqat csp-violation, takror count bilan', async () => {
    const violation = {
      type: 'csp-violation',
      age: 3,
      url: 'https://elchipochta.uz/login',
      user_agent: 'Mozilla/5.0',
      body: {
        documentURL: 'https://elchipochta.uz/login',
        blockedURL: 'inline',
        effectiveDirective: 'script-src-elem',
        disposition: 'report',
        sample: 'window.__theme',
        lineNumber: 93,
      },
    };
    const res = await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/reports+json')
      .set('CF-Connecting-IP', nextIp())
      .send(
        JSON.stringify([
          violation,
          violation,
          { type: 'deprecation', url: 'https://elchipochta.uz/', body: {} },
        ]),
      )
      .expect(204);
    expect(res.text).toBe('');
    const logs = cspLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        format: 'report-to',
        document_uri: 'https://elchipochta.uz/login',
        blocked_uri: 'inline',
        effective_directive: 'script-src-elem',
        line_number: 93,
        count: 2,
      }),
    );
  });

  it('charset bilan ham qabul qilinadi; /v1/csp-report ham ishlaydi', async () => {
    await request(http())
      .post('/v1/csp-report')
      .set('Content-Type', 'application/csp-report; charset=utf-8')
      .set('CF-Connecting-IP', nextIp())
      .send(JSON.stringify(LEGACY))
      .expect(204);
    expect(cspLogs()).toHaveLength(1);
  });

  it('JWT yaroqsiz bo‘lsa ham (public) — 204', async () => {
    await request(http())
      .post('/csp-report')
      .set('Authorization', 'Bearer not-a-jwt')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .send(JSON.stringify(LEGACY))
      .expect(204);
  });

  it('⭐ kiritilgan matn hech qachon javobga qaytmaydi (XSS namunasi bilan)', async () => {
    const payload = {
      'csp-report': {
        ...LEGACY['csp-report'],
        'blocked-uri': 'inline',
        'effective-directive': 'script-src',
        'script-sample': '<script>alert("ECHO-MARKER")</script>',
      },
    };
    const res = await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .send(JSON.stringify(payload))
      .expect(204);
    expect(res.text).toBe('');
    expect(JSON.stringify(res.headers)).not.toContain('ECHO-MARKER');
  });

  it.each([
    ['application/json', JSON.stringify(LEGACY)],
    ['text/plain', 'ECHO-MARKER'],
    ['application/x-www-form-urlencoded', 'a=ECHO-MARKER'],
  ])(
    '⭐ Content-Type %s → 415, kiritilgan matn qaytmaydi, log yo‘q',
    async (type, body) => {
      const res = await request(http())
        .post('/csp-report')
        .set('Content-Type', type)
        .set('CF-Connecting-IP', nextIp())
        .send(body)
        .expect(415);
      expect(res.text).not.toContain('ECHO-MARKER');
      expect(res.text).not.toContain('qrserver');
      expect(cspLogs()).toHaveLength(0);
    },
  );

  it(`⭐ tana > ${CSP_REPORT_BODY_LIMIT_BYTES / 1024} KB → 413, kiritilgan matn qaytmaydi`, async () => {
    const big = JSON.stringify({
      'csp-report': {
        'effective-directive': 'img-src',
        'blocked-uri': 'inline',
        'script-sample': 'ECHO-MARKER'.repeat(4000),
      },
    });
    expect(big.length).toBeGreaterThan(CSP_REPORT_BODY_LIMIT_BYTES);
    const res = await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .send(big)
      .expect(413);
    expect(res.text).not.toContain('ECHO-MARKER');
    expect(cspLogs()).toHaveLength(0);
  });

  it('buzuq JSON → 400, parser xabari/tana parchasi qaytmaydi', async () => {
    const res = await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .send('{"csp-report": ECHO-MARKER')
      .expect(400);
    expect(res.text).not.toContain('ECHO-MARKER');
    expect(cspLogs()).toHaveLength(0);
  });

  it('siqilgan (gzip) tana qabul qilinmaydi — 415', async () => {
    await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('Content-Encoding', 'gzip')
      .set('CF-Connecting-IP', nextIp())
      .send('xxxx')
      .expect(415);
  });

  it('bo‘sh tana / CSP bo‘lmagan hisobot — 204, log yo‘q; turi yo‘q bo‘lsa 415', async () => {
    await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .send('')
      .expect(204);
    await request(http())
      .post('/csp-report')
      .set('Content-Type', 'application/reports+json')
      .set('CF-Connecting-IP', nextIp())
      .send(JSON.stringify([{ type: 'intervention', body: {} }]))
      .expect(204);
    await request(http())
      .post('/csp-report')
      .set('CF-Connecting-IP', nextIp())
      .expect(415);
    expect(cspLogs()).toHaveLength(0);
  });

  it('⭐ per-IP 30/daqiqa: 31-so‘rov 429; boshqa IP o‘tadi', async () => {
    const ip = nextIp();
    const send = (from: string) =>
      request(http())
        .post('/csp-report')
        .set('Content-Type', 'application/csp-report')
        .set('CF-Connecting-IP', from)
        .send(JSON.stringify(LEGACY));
    for (let i = 0; i < 30; i += 1) {
      await send(ip).expect(204);
    }
    const res = await send(ip).expect(429);
    expect(res.text).not.toContain('qrserver');
    await send(nextIp()).expect(204);
  });
});
