import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SsrfRedirectBlockedError } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * (dgvwZasd A) SSRF himoyasini redirect bilan aylanib o'tish — integratsiya
 * chiquvchi so'rovlari.
 *
 * Ssenariy: operator sozlagan manzil ochiq host (DNS tekshiruvidan o'tadi —
 * shu sababli `assertOutboundUrlSafe` bu yerda "o'tdi" deb mock qilinadi),
 * lekin u 302 bilan so'rovni ichki xizmatga (`rabbitmq:15672` o'rnida lokal
 * server) yo'naltiradi. Ilgari `fetch()` ergashardi; endi so'rov rad etiladi
 * va ichki manzilga BIRORTA so'rov yetmaydi. Serverlar haqiqiy (mock emas).
 */
describe('Integratsiya chiquvchi so‘rovlari redirect’ga ergashmaydi (dgvwZasd)', () => {
  let internal: Server;
  let redirector: Server;
  let internalHits = 0;
  let redirectorUrl = '';

  const listen = (server: Server) =>
    new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.end('{"ok":true}');
    });
    const internalBase = await listen(internal);
    redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: `${internalBase}/api/overview` });
      res.end();
    });
    redirectorUrl = `${await listen(redirector)}/webhooks/elchi`;
  });

  afterAll(async () => {
    await new Promise((r) => internal.close(r));
    await new Promise((r) => redirector.close(r));
  });

  beforeEach(() => {
    internalHits = 0;
  });

  function makeSvc(partner: Record<string, unknown>) {
    const svc: any = Object.create(IntegrationServiceService.prototype);
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.partnerRepo = { findOne: jest.fn().mockResolvedValue(partner) };
    svc.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    // Birinchi manzil "ochiq" deb o'tadi — hujum aynan shu bo'shliqda.
    svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
    svc.decryptCredential = jest.fn(() => 'topsecret');
    svc.resolvePartnerWebhookSecret = jest.fn(() => 'topsecret');
    return svc;
  }

  it('hamkor webhooki (outbox yetkazish): redirect rad etiladi, ichki manzil chaqirilmaydi', async () => {
    const svc = makeSvc({ id: '7', webhook_url: redirectorUrl });

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        payload: { event: 'shipment.status_changed' },
      }),
    ).rejects.toBeInstanceOf(SsrfRedirectBlockedError);
    expect(internalHits).toBe(0);
  });

  it('sinov webhooki: ok:false + aniq sabab, ichki manzil chaqirilmaydi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: redirectorUrl,
      webhook_secret: 'enc:x',
      isDeleted: false,
    });

    const res: any = await svc.testPartnerWebhook('7');

    expect(res.data.ok).toBe(false);
    expect(res.data.http_status).toBeNull();
    expect(String(res.data.error)).toMatch(/Redirect blocked/);
    expect(internalHits).toBe(0);
  });

  it("servisda to'g'ridan-to'g'ri fetch() qolmagan — 6 joy ham fetchWithoutRedirect", () => {
    // Fayl ichida NUL bayt bor — matn sifatida o'qiladi, regex unga befarq.
    const source = readFileSync(
      join(__dirname, 'integration-service.service.ts'),
      'utf8',
    );
    const bareFetch = source.match(/(?<![\w.])fetch\(/g) ?? [];
    const guarded = source.match(/\bfetchWithoutRedirect\(/g) ?? [];
    expect(bareFetch).toHaveLength(0);
    expect(guarded).toHaveLength(6);
  });
});
