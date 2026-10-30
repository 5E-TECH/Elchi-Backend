import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SsrfBlockedError } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * (dgvwZasd B) DNS rebinding — integratsiya chiquvchi so'rovlari.
 *
 * Ssenariy: `assertOutboundUrlSafe` o'tdi (ochiq IP), ulanish paytida esa DNS
 * ichki manzilni qaytaradi. Server haqiqiy; so'rov unga yetmasligi shart.
 */
describe('Integratsiya so‘rovlari tekshirilgan IP’ga ulanadi (dgvwZasd B)', () => {
  let internal: Server;
  let internalHits = 0;
  let url = '';

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.end('{"ok":true}');
    });
    const port = await new Promise<number>((resolve) =>
      internal.listen(0, '127.0.0.1', () =>
        resolve((internal.address() as AddressInfo).port),
      ),
    );
    url = `http://rebind.example.test:${port}/webhooks/elchi`;
  });

  afterAll(async () => {
    internal.closeAllConnections();
    await new Promise((r) => internal.close(r));
  });

  beforeEach(() => {
    internalHits = 0;
    jest.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      setImmediate(() =>
        options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }])
          : callback(null, '127.0.0.1', 4),
      );
    }) as unknown as typeof dns.lookup);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeSvc(partner: Record<string, unknown>) {
    const svc: any = Object.create(IntegrationServiceService.prototype);
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.partnerRepo = { findOne: jest.fn().mockResolvedValue(partner) };
    svc.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    // Tekshiruv o'tdi — hujum aynan shundan keyingi oynada.
    svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
    svc.decryptCredential = jest.fn(() => 'topsecret');
    svc.resolvePartnerWebhookSecret = jest.fn(() => 'topsecret');
    return svc;
  }

  it('⭐ hamkor webhooki: rebinding rad etiladi, ichki manzilga so‘rov yetmaydi', async () => {
    const svc = makeSvc({ id: '7', webhook_url: url });

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        payload: {
          event: 'shipment.status_changed',
          external_order_id: 'ord-9',
        },
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(internalHits).toBe(0);
  });

  it('sinov webhooki: ok:false + aniq sabab', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: url,
      webhook_secret: 'enc:x',
      isDeleted: false,
    });

    const res: any = await svc.testPartnerWebhook('7');

    expect(res.data.ok).toBe(false);
    expect(res.data.http_status).toBeNull();
    expect(String(res.data.error)).toMatch(/non-public address/);
    expect(internalHits).toBe(0);
  });

  it('`INTEGRATION_ALLOW_PRIVATE_HOSTS` — dev: guard’siz ulanadi', async () => {
    const svc = makeSvc({ id: '7' });
    svc.allowPrivateHosts = true;

    const res: Response = await svc.outboundFetch(url, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(internalHits).toBe(1);
  });
});
