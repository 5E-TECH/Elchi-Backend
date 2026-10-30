import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { Agent } from 'undici';
import {
  assertPublicUrl,
  createPinnedLookup,
  fetchPinned,
  isBlockedAddress,
  SsrfBlockedError,
  SsrfRedirectBlockedError,
} from './ssrf';

/**
 * (dgvwZasd B) SSRF DNS pinning — rebinding.
 *
 * Hujum: tekshiruv paytida DNS ochiq IP beradi, `connect` paytida esa
 * (TTL 0) ichki IP. Serverlar HAQIQIY: "ichki" server 127.0.0.1 da, DNS esa
 * ikki bosqichda alohida boshqariladi:
 *   - `dns/promises.lookup` — `assertPublicUrl` tekshiruvi;
 *   - `dns.lookup` — ulanish paytidagi nom yechish (`net.connect` sukuti).
 * Himoyasiz `fetch` ikkinchi javobga ulanadi va ichki serverga yetadi.
 */
type Answer = { address: string; family: number };

const v4 = (address: string): Answer => ({ address, family: 4 });
const v6 = (address: string): Answer => ({ address, family: 6 });

const PUBLIC_IP = '93.184.216.34';

/** `dns.lookup` o'rnini bosadi: `all` bo'lsa ro'yxat, bo'lmasa bitta manzil. */
function mockConnectDns(result: Answer[] | NodeJS.ErrnoException) {
  return jest.spyOn(dns, 'lookup').mockImplementation(((
    _host: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    const opts = (typeof options === 'object' && options) as { all?: boolean };
    setImmediate(() => {
      if (!Array.isArray(result)) return callback(result);
      if (opts && opts.all) return callback(null, result);
      return callback(null, result[0]?.address, result[0]?.family);
    });
  }) as unknown as typeof dns.lookup);
}

function mockCheckDns(result: Answer[]) {
  return jest
    .spyOn(dnsPromises, 'lookup')
    .mockResolvedValue(result as unknown as dns.LookupAddress);
}

const listen = (server: Server, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

const closeServer = (server: Server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

const enotfound = () =>
  Object.assign(new Error('getaddrinfo ENOTFOUND rebind.example.test'), {
    code: 'ENOTFOUND',
  });

describe('SSRF DNS pinning (dgvwZasd B)', () => {
  let internal: Server;
  let port = 0;
  let hits = 0;
  let lastHost = '';

  beforeAll(async () => {
    internal = createServer((req, res) => {
      hits += 1;
      lastHost = String(req.headers.host ?? '');
      res.end('{"ok":true}');
    });
    port = await listen(internal, '127.0.0.1');
  });

  afterAll(async () => {
    await closeServer(internal);
  });

  beforeEach(() => {
    hits = 0;
    lastHost = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const target = () => `http://rebind.example.test:${port}/api/overview`;

  describe('rebinding', () => {
    it('⭐ tekshiruvda ochiq IP, ulanishda ichki IP — rad etiladi, ichki serverga so‘rov yetmaydi', async () => {
      mockCheckDns([v4(PUBLIC_IP)]);
      mockConnectDns([v4('127.0.0.1')]);

      await expect(assertPublicUrl(target())).resolves.toBeUndefined();
      await expect(fetchPinned(target())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(hits).toBe(0);
    });

    it.each([
      ['IPv4 ichki', [v4('10.0.0.5')]],
      ['bulut metadata', [v4('169.254.169.254')]],
      ['IPv6 loopback', [v6('::1')]],
      ['IPv6 ULA', [v6('fd00::1')]],
      ['mapped IPv4 (nuqtali)', [v6('::ffff:127.0.0.1')]],
      ['mapped IPv4 (hex)', [v6('::ffff:7f00:1')]],
      ['ochiq + ichki aralash', [v4(PUBLIC_IP), v4('127.0.0.1')]],
    ])('ulanish javobi: %s — rad', async (_name, answers) => {
      mockConnectDns(answers);
      await expect(fetchPinned(target())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(hits).toBe(0);
    });

    it('xato matnida faqat host — yo‘l va so‘rov qatori (token) yo‘q', async () => {
      mockConnectDns([v4('127.0.0.1')]);
      const error = (await fetchPinned(`${target()}?token=s3cr3t-value`).catch(
        (e: unknown) => e,
      )) as Error;
      expect(error.message).toContain('rebind.example.test');
      expect(error.message).not.toContain('s3cr3t-value');
    });
  });

  describe('DNS xatosi xavfsiz rad etiladi', () => {
    it('ulanishda ENOTFOUND → SsrfBlockedError (TypeError emas)', async () => {
      mockConnectDns(enotfound());
      await expect(fetchPinned(target())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(hits).toBe(0);
    });

    it('ulanishda bo‘sh javob → rad', async () => {
      mockConnectDns([]);
      await expect(fetchPinned(target())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      expect(hits).toBe(0);
    });

    it('tekshiruvda DNS xatosi → rad (assertPublicUrl)', async () => {
      jest.spyOn(dnsPromises, 'lookup').mockRejectedValue(enotfound());
      await expect(assertPublicUrl(target())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    });
  });

  describe('URL literal IP va sxema — DNS’siz rad', () => {
    it.each([
      ['IPv4', () => `http://127.0.0.1:${port}/x`],
      ['o‘nlik IPv4', () => `http://2130706433:${port}/x`],
      ['o‘n oltilik IPv4', () => `http://0x7f.0.0.1:${port}/x`],
      ['IPv6', () => `http://[::1]:${port}/x`],
      ['mapped IPv4', () => `http://[::ffff:127.0.0.1]:${port}/x`],
    ])('%s', async (_name, url) => {
      await expect(fetchPinned(url())).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(hits).toBe(0);
    });

    it('http(s) bo‘lmagan sxema va buzuq URL', async () => {
      await expect(fetchPinned('file:///etc/passwd')).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      await expect(fetchPinned('not a url')).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    });
  });

  describe('ruxsat etilgan manzil tekshirilgan IP’ga ulanadi', () => {
    /** Lokal server "ochiq" hisoblanadi — real ulanishni kuzatish uchun. */
    const permissive = (connect: Record<string, unknown> = {}) =>
      new Agent({
        connect: { lookup: createPinnedLookup(() => false), ...connect },
      });

    it('nom yechilgan IP’ga ulanadi, Host sarlavhasi asl host', async () => {
      mockConnectDns([v4('127.0.0.1')]);
      const dispatcher = permissive();
      const res = await fetch(target(), { dispatcher } as RequestInit);
      await dispatcher.close();

      expect(res.status).toBe(200);
      expect(hits).toBe(1);
      expect(lastHost).toBe(`rebind.example.test:${port}`);
    });

    it('IPv6 javob: ::1 ga ulanadi', async () => {
      const server = createServer((_req, res) => {
        hits += 1;
        res.end('ok');
      });
      let v6Port: number;
      try {
        v6Port = await listen(server, '::1');
      } catch {
        return; // Muhitda IPv6 loopback yo'q — tekshiruvsiz o'tadi.
      }
      mockConnectDns([v6('::1')]);
      const dispatcher = permissive();
      const res = await fetch(`http://ipv6.example.test:${v6Port}/`, {
        dispatcher,
      } as RequestInit);
      await dispatcher.close();
      await closeServer(server);

      expect(res.status).toBe(200);
      expect(hits).toBe(1);
    });

    describe('TLS', () => {
      const HOST = 'partner.example.test';
      let dir = '';
      let key: Buffer;
      let cert: Buffer;

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'ssrf-pin-'));
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'ec',
            '-pkeyopt',
            'ec_paramgen_curve:prime256v1',
            '-nodes',
            '-keyout',
            join(dir, 'k.pem'),
            '-out',
            join(dir, 'c.pem'),
            '-days',
            '1',
            '-subj',
            `/CN=${HOST}`,
            '-addext',
            `subjectAltName=DNS:${HOST}`,
          ],
          { stdio: 'ignore' },
        );
        key = readFileSync(join(dir, 'k.pem'));
        cert = readFileSync(join(dir, 'c.pem'));
      });

      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      const tlsServer = async () => {
        const seen: { sni?: string | false; host?: string } = {};
        const server = createTlsServer({ key, cert }, (req, res) => {
          seen.sni = (req.socket as TLSSocket).servername;
          seen.host = req.headers.host;
          res.end('ok');
        });
        const tlsPort = await listen(server, '127.0.0.1');
        return { server, tlsPort, seen };
      };

      it('⭐ SNI va sertifikat tekshiruvi — IP emas, asl hostname bo‘yicha', async () => {
        const { server, tlsPort, seen } = await tlsServer();
        mockConnectDns([v4('127.0.0.1')]);
        const dispatcher = permissive({ ca: cert });

        const res = await fetch(`https://${HOST}:${tlsPort}/hook`, {
          dispatcher,
        } as RequestInit);
        await dispatcher.close();
        await closeServer(server);

        expect(res.status).toBe(200);
        expect(seen.sni).toBe(HOST);
        expect(seen.host).toBe(`${HOST}:${tlsPort}`);
      });

      it('sertifikat boshqa hostname uchun bo‘lsa — ulanish rad etiladi', async () => {
        const { server, tlsPort } = await tlsServer();
        mockConnectDns([v4('127.0.0.1')]);
        const dispatcher = permissive({ ca: cert });

        const error = (await fetch(`https://other.example.test:${tlsPort}/`, {
          dispatcher,
        } as RequestInit).catch((e: unknown) => e)) as {
          cause?: { code?: string };
        };
        await dispatcher.close();
        await closeServer(server);

        expect(error.cause?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
      });
    });
  });

  describe('createPinnedLookup — javob shakli', () => {
    const call = (options: dns.LookupOptions) =>
      new Promise<unknown[]>((resolve) => {
        createPinnedLookup()('h.example.test', options, (...args: unknown[]) =>
          resolve(args),
        );
      });

    it('`all: true` — butun ro‘yxat (happy eyeballs)', async () => {
      const answers = [v4(PUBLIC_IP), v6('2606:4700:4700::1111')];
      mockConnectDns(answers);
      await expect(call({ all: true })).resolves.toEqual([null, answers]);
    });

    it('`all` yo‘q — birinchi manzil va oila', async () => {
      mockConnectDns([v6('2606:4700:4700::1111')]);
      await expect(call({})).resolves.toEqual([
        null,
        '2606:4700:4700::1111',
        6,
      ]);
    });
  });

  describe('fetchPinned va mavjud himoyalar', () => {
    it('redirect avvalgidek rad etiladi (allowPrivate — lokal server)', async () => {
      const redirector = createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/x' });
        res.end();
      });
      const redirectPort = await listen(redirector, '127.0.0.1');
      await expect(
        fetchPinned(
          `http://127.0.0.1:${redirectPort}/`,
          {},
          {
            allowPrivate: true,
          },
        ),
      ).rejects.toBeInstanceOf(SsrfRedirectBlockedError);
      await closeServer(redirector);
    });

    it('`allowPrivate` — guard’siz (dev), dispatcher berilmaydi', async () => {
      const realFetch = global.fetch;
      const fetchMock = jest.fn(() =>
        Promise.resolve(new Response('ok', { status: 200 })),
      );
      global.fetch = fetchMock;
      try {
        await fetchPinned('http://rabbitmq:15672/', {}, { allowPrivate: true });
      } finally {
        global.fetch = realFetch;
      }
      const init = (fetchMock.mock.calls[0] as unknown[])[1] as object;
      expect(init).not.toHaveProperty('dispatcher');
    });

    it("global fetch'ga redirect:error va dispatcher bilan uzatadi (mock'lar ishlaydi)", async () => {
      const realFetch = global.fetch;
      const fetchMock = jest.fn(() =>
        Promise.resolve(new Response('ok', { status: 200 })),
      );
      global.fetch = fetchMock;
      try {
        await fetchPinned('https://partner.example.com/hook', {
          method: 'POST',
        });
      } finally {
        global.fetch = realFetch;
      }
      expect(fetchMock).toHaveBeenCalledWith(
        'https://partner.example.com/hook',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          dispatcher: expect.anything(),
        }),
      );
    });
  });

  describe('isBlockedAddress — IPv6 va ichiga joylangan IPv4', () => {
    it.each([
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.1.2.3',
      '::ffff:0:127.0.0.1', // SIIT (IPv4-translated)
      '::127.0.0.1', // IPv4-compatible
      '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
      '64:ff9b::a9fe:a9fe', // NAT64 → metadata
      '2002:7f00:1::', // 6to4 → 127.0.0.1
      '2002:a00:1::1', // 6to4 → 10.0.0.1
      'fe80::1',
      'fe80::1%eth0',
      'fec0::1', // site-local (eskirgan)
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1', // hujjat
      '100::1', // discard
      '2001::1', // Teredo
    ])('blok: %s', (addr) => {
      expect(isBlockedAddress(addr)).toBe(true);
    });

    it.each([
      '2606:4700:4700::1111',
      '2a00:1450:4001:81b::200e',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ])('ochiq: %s', (addr) => {
      expect(isBlockedAddress(addr)).toBe(false);
    });

    it('IP bo‘lmagan qiymat — fail closed', () => {
      expect(isBlockedAddress('example.com')).toBe(true);
      expect(isBlockedAddress('')).toBe(true);
    });
  });
});
