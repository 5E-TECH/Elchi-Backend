import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchWithoutRedirect,
  SsrfBlockedError,
  SsrfRedirectBlockedError,
} from './ssrf';

/**
 * (dgvwZasd A) SSRF himoyasini redirect bilan aylanib o'tish.
 *
 * `assertPublicUrl` faqat birinchi manzilni tekshiradi. Ochiq host 3xx bilan
 * so'rovni ichki xizmatga (`rabbitmq:15672`, `minio:9000`) yo'naltirsa, oddiy
 * `fetch()` unga ergashardi. Bu yerda HAQIQIY HTTP serverlar ishlatiladi:
 * "ichki" server — redirect manzili, unga bitta ham so'rov yetmasligi shart.
 */
describe('fetchWithoutRedirect (dgvwZasd)', () => {
  let internal: Server;
  let redirector: Server;
  let internalHits = 0;
  let internalUrl = '';
  let redirectorBase = '';
  let lastRedirectStatus = 302;

  const listen = (server: Server) =>
    new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.end('rabbitmq management overview');
    });
    internalUrl = `${await listen(internal)}/api/overview`;

    redirector = createServer((req, res) => {
      if (req.url?.startsWith('/ok')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      const status = Number(req.url?.split('/')[2]) || 302;
      lastRedirectStatus = status;
      res.writeHead(status, { Location: internalUrl });
      res.end();
    });
    redirectorBase = await listen(redirector);
  });

  afterAll(async () => {
    await new Promise((r) => internal.close(r));
    await new Promise((r) => redirector.close(r));
  });

  beforeEach(() => {
    internalHits = 0;
  });

  it.each([301, 302, 303, 307, 308])(
    'HTTP %i redirect rad etiladi, ichki manzil chaqirilmaydi',
    async (status) => {
      await expect(
        fetchWithoutRedirect(`${redirectorBase}/r/${status}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ).rejects.toBeInstanceOf(SsrfRedirectBlockedError);
      expect(lastRedirectStatus).toBe(status);
      expect(internalHits).toBe(0);
    },
  );

  it('redirect xatosi SsrfBlockedError avlodi (mavjud guard ushlaydi)', async () => {
    const error = await fetchWithoutRedirect(`${redirectorBase}/r/302`).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect((error as Error).message).toMatch(/Redirect blocked/);
  });

  it("chaqiruvchi `redirect: 'follow'` bersa ham ustidan yoziladi", async () => {
    await expect(
      fetchWithoutRedirect(`${redirectorBase}/r/302`, { redirect: 'follow' }),
    ).rejects.toBeInstanceOf(SsrfRedirectBlockedError);
    expect(internalHits).toBe(0);
  });

  it("xato matnida faqat origin — yo'l va so'rov qatori (token) yo'q", async () => {
    const error = (await fetchWithoutRedirect(
      `${redirectorBase}/r/302?token=s3cr3t-value`,
    ).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain(redirectorBase);
    expect(error.message).not.toContain('s3cr3t-value');
    expect(error.message).not.toContain('/r/302');
  });

  it('redirect bo‘lmasa javob avvalgidek qaytadi', async () => {
    const res = await fetchWithoutRedirect(`${redirectorBase}/ok`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("tarmoq xatosi o'zgarishsiz qaytadi (redirect xatosiga aylanmaydi)", async () => {
    // Yopilgan port — ECONNREFUSED.
    const closed = createServer();
    const base = await listen(closed);
    await new Promise((r) => closed.close(r));

    const error = await fetchWithoutRedirect(`${base}/x`).catch(
      (e: unknown) => e,
    );
    // undici xatosi boshqa realm'dan (Jest VM) — `instanceof TypeError`
    // emas, nomi bo'yicha tekshiriladi.
    expect((error as Error).name).toBe('TypeError');
    expect((error as Error).message).toBe('fetch failed');
    expect(error).not.toBeInstanceOf(SsrfBlockedError);
  });

  it("global fetch'ga `redirect: 'error'` bilan uzatadi (mock'lar ishlaydi)", async () => {
    const realFetch = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await fetchWithoutRedirect('https://partner.example.com/hook', {
        method: 'POST',
        body: '{}',
      });
    } finally {
      global.fetch = realFetch;
    }
    expect(fetchMock).toHaveBeenCalledWith(
      'https://partner.example.com/hook',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        redirect: 'error',
      }),
    );
  });
});
