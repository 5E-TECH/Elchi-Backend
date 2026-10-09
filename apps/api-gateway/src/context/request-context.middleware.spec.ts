import type { Request, Response } from 'express';
import { requestContext } from '@app/common';
import {
  ClientIpThrottlerGuard,
  resolveTrustedClientIp,
} from '../auth/client-ip-throttler.guard';
import { describeUserAgent } from './device-label';
import {
  buildRequestContextStore,
  requestContextMiddleware,
} from './request-context.middleware';

/**
 * f2Ud5tju — gateway'da audit konteksti: haqiqiy mijoz IP'si, User-Agent
 * (256 gacha), qurilma; webhook oqimida bo'sh.
 */
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function req(over: Partial<Request> & { headers?: Record<string, any> } = {}) {
  return {
    path: '/orders',
    url: '/orders',
    ip: '172.18.0.5', // Cloudflare tunnel konteyneri
    ips: [],
    ...over,
    headers: { 'user-agent': CHROME_ANDROID, ...(over.headers ?? {}) },
  } as unknown as Request;
}

describe('buildRequestContextStore (f2Ud5tju)', () => {
  it('TC3 Cloudflare ortida: CF-Connecting-IP olinadi, tunnel IP / soxta XFF emas', () => {
    const store = buildRequestContextStore(
      req({
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '6.6.6.6, 172.18.0.5', // mijoz soxtalashtirgan
        },
      }),
    );
    expect(store.ip).toBe('203.0.113.7');
  });

  it('TC3 rate-limit bilan AYNI manba (ClientIpThrottlerGuard.getTracker)', async () => {
    const guard = Object.create(ClientIpThrottlerGuard.prototype) as {
      getTracker: (r: unknown) => Promise<string>;
    };
    for (const r of [
      req({ headers: { 'cf-connecting-ip': ' 203.0.113.7 ' } }),
      req({ headers: { 'cf-connecting-ip': '   ' } }),
      req({ ip: undefined, ips: ['10.0.0.9'] }),
    ]) {
      expect(resolveTrustedClientIp(r)).toBe(await guard.getTracker(r));
    }
  });

  it('sarlavha bo`lmasa req.ip, `::ffff:` prefiks olib tashlanadi', () => {
    expect(buildRequestContextStore(req({ ip: '::ffff:10.1.2.3' })).ip).toBe(
      '10.1.2.3',
    );
  });

  it('TC4 user_agent 256 belgidan uzun bo`lsa kesiladi', () => {
    const store = buildRequestContextStore(
      req({
        headers: { 'user-agent': `${CHROME_ANDROID} ${'x'.repeat(1000)}` },
      }),
    );
    expect(store.user_agent).toHaveLength(256);
    expect(store.user_agent?.startsWith('Mozilla/5.0')).toBe(true);
  });

  it('TC1 device_name: X-Device-Name (URL-encoded) yoki User-Agent`dan', () => {
    const named = buildRequestContextStore(
      req({
        headers: {
          'x-device-id': 'a1b2-c3',
          'x-device-name': encodeURIComponent('Dilshodning noutbugi'),
        },
      }),
    );
    expect(named).toMatchObject({
      device_id: 'a1b2-c3',
      device_name: 'Dilshodning noutbugi',
    });
    const derived = buildRequestContextStore(req());
    expect(derived.device_name).toBe('Telefon · Android · Chrome');
    expect(derived.user_agent).toBe(CHROME_ANDROID);
  });

  it('TC2 webhook (mashina→mashina) — faqat traceId, IP/qurilma YO`Q', () => {
    for (const path of [
      '/webhooks/sms/eskiz',
      '/v1/webhooks/bts',
      '/webhooks',
    ]) {
      const store = buildRequestContextStore(
        req({ path, headers: { 'cf-connecting-ip': '203.0.113.7' } }),
      );
      expect(Object.keys(store)).toEqual(['traceId']);
    }
  });

  it('x-request-id: to`g`ri qiymat saqlanadi, uzun/g`alati qiymat yangi UUID', () => {
    expect(
      buildRequestContextStore(req({ headers: { 'x-request-id': 'abc-123' } }))
        .traceId,
    ).toBe('abc-123');
    const long = buildRequestContextStore(
      req({ headers: { 'x-request-id': 'x'.repeat(65) } }),
    ).traceId;
    expect(long).toMatch(/^[0-9a-f-]{36}$/);
    const weird = buildRequestContextStore(
      req({ headers: { 'x-request-id': "a'; DROP" } }),
    ).traceId;
    expect(weird).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('requestContextMiddleware', () => {
  it('keyingi zanjir kontekst ICHIDA ishlaydi va x-request-id qaytariladi', () => {
    const setHeader = jest.fn();
    let seen: unknown;
    requestContextMiddleware(
      req({ headers: { 'cf-connecting-ip': '203.0.113.7' } }),
      { setHeader } as unknown as Response,
      () => {
        seen = requestContext.get();
      },
    );
    expect(seen).toMatchObject({
      ip: '203.0.113.7',
      device_name: 'Telefon · Android · Chrome',
    });
    expect(setHeader).toHaveBeenCalledWith(
      'x-request-id',
      (seen as { traceId: string }).traceId,
    );
  });
});

describe('describeUserAgent', () => {
  it.each([
    [CHROME_ANDROID, 'Telefon · Android · Chrome'],
    [CHROME_LINUX, 'Kompyuter · Linux · Chrome'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Telefon · iOS · Safari',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Kompyuter · Windows · Edge',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/127.0',
      'Kompyuter · macOS · Firefox',
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Planshet · Android · Chrome',
    ],
  ])('%s → %s', (ua, label) => {
    expect(describeUserAgent(ua)).toBe(label);
  });

  it('aniqlab bo`lmasa sun`iy yorliq qo`yilmaydi', () => {
    expect(describeUserAgent('curl/8.5.0')).toBeUndefined();
    expect(describeUserAgent('')).toBeUndefined();
    expect(describeUserAgent(undefined)).toBeUndefined();
  });
});
