import { RpcException } from '@nestjs/microservices';
import { SsrfRedirectBlockedError } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * «ALOQANI SINASH» — 2026-11-25 (ega): ishlab turgan sayt (Lidershop) «xato»
 * chiqardi. Sinov `GET https://api.lidershop.uz/` yuborardi, sayt 404
 * qaytarardi — ok:false va qizil «integration healthcheck completed».
 */
type Row = Record<string, any>;

const reply = (status: number) => () =>
  Promise.resolve({ status, ok: status >= 200 && status < 300 });

function svc(over: {
  auth_type?: 'login' | 'api_key';
  fetch?: () => Promise<unknown>;
  login?: () => Promise<string>;
  apiKey?: string | null;
}) {
  const s = Object.create(IntegrationServiceService.prototype) as Row;
  Object.assign(s, {
    integrationRepo: {
      findOne: jest.fn().mockResolvedValue({
        id: '3',
        slug: 'lidershop',
        name: 'Lidershop',
        is_active: true,
        api_url: 'https://api.lidershop.uz',
        auth_type: over.auth_type ?? 'login',
        api_key: null,
      }),
    },
    tokenCache: new Map([['3', { token: 'eski', expiresAt: Infinity }]]),
    loginAndGetToken: jest.fn(over.login ?? (() => Promise.resolve('yangi'))),
    decryptCredential: () => over.apiKey ?? null,
    assertOutboundUrlSafe: jest.fn().mockResolvedValue(undefined),
    outboundFetch: jest.fn(over.fetch ?? reply(404)),
  });
  return s;
}

const check = (s: Row, input: Row = {}) =>
  s.healthcheckIntegration({ id: '3', ...input }) as Promise<Row>;

describe('Aloqani sinash — tugma (endpoint berilmagan)', () => {
  it.each([200, 204, 400, 404, 405, 422])(
    '⭐ login o`tdi, bosh manzil HTTP %i — aloqa BOR',
    async (status) => {
      const res = await check(svc({ fetch: reply(status) }));
      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({
        ok: true,
        reason: null,
        status,
        auth_verified: true,
      });
    },
  );

  it('⭐ login DOIM yangidan — keshdagi token bilan sinalmaydi', async () => {
    const s = svc({});
    await check(s);
    expect(s.loginAndGetToken).toHaveBeenCalledTimes(1);
    expect(s.outboundFetch.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer yangi',
    );
  });

  it('⭐ login o`tmadi — sababi o`zbekcha, saytga so`rov ketmaydi', async () => {
    const s = svc({
      login: () =>
        Promise.reject(
          new RpcException({
            statusCode: 400,
            message:
              'Integration login failed: Integration login failed: Unauthorized',
          }),
        ),
    });
    const res = await check(s);
    expect(res.data).toMatchObject({ ok: false, reason: 'auth_failed' });
    expect(res.message).toContain("Login o'tmadi");
    expect(res.message).toContain('(Unauthorized)');
    expect(s.outboundFetch).not.toHaveBeenCalled();
  });

  it('401 — kalit qabul qilinmadi (login o`tgan bo`lsa ham)', async () => {
    const res = await check(svc({ fetch: reply(401) }));
    expect(res.data).toMatchObject({ ok: false, reason: 'auth_rejected' });
    expect(res.message).toContain('HTTP 401');
  });

  it('403 — login o`tgan bo`lsa aloqa bor, kalitli turda rad', async () => {
    expect((await check(svc({ fetch: reply(403) }))).data.ok).toBe(true);
    const keyed = await check(
      svc({ auth_type: 'api_key', apiKey: 'k', fetch: reply(403) }),
    );
    expect(keyed.data).toMatchObject({
      ok: false,
      reason: 'auth_rejected',
      auth_verified: false,
    });
  });

  it('5xx — saytning xatosi', async () => {
    const res = await check(svc({ fetch: reply(503) }));
    expect(res.data).toMatchObject({ ok: false, reason: 'server_error' });
  });

  it('javob kelmadi / ulanib bo`lmadi', async () => {
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    const slow = await check(svc({ fetch: () => Promise.reject(timeout) }));
    expect(slow.data.reason).toBe('timeout');
    expect(slow.message).toBe('Sayt 8 soniyada javob bermadi');
    const down = await check(
      svc({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) }),
    );
    expect(down.data.reason).toBe('unreachable');
    expect(down.message).toContain('ECONNREFUSED');
  });

  it('yo`naltirish — server bor (ergashilmaydi)', async () => {
    const res = await check(
      svc({ fetch: () => Promise.reject(new SsrfRedirectBlockedError('3xx')) }),
    );
    expect(res.data.ok).toBe(true);
  });

  it('⭐ yiqilganda xabar hech qachon «healthcheck completed» emas', async () => {
    for (const status of [401, 500, 503]) {
      const res = await check(svc({ fetch: reply(status) }));
      expect(res.statusCode).toBe(502);
      expect(res.message).not.toMatch(/completed|healthcheck/i);
    }
  });
});

describe('Aloqani sinash — aniq endpoint (qat`iy)', () => {
  it('404 — yiqilgan; 200 — muvaffaqiyat', async () => {
    const bad = await check(svc({ fetch: reply(404) }), { endpoint: '/ping' });
    expect(bad.data).toMatchObject({ ok: false, reason: 'endpoint_failed' });
    const good = await check(svc({ fetch: reply(200) }), { endpoint: '/ping' });
    expect(good.data.ok).toBe(true);
  });
});
