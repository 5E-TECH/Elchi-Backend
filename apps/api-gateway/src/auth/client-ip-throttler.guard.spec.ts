import {
  CLOUDFLARE_WORKER_EGRESS_IP,
  ClientIpThrottlerGuard,
  createWorkerEgressIpWarner,
  isCloudflareWorkerEgressIp,
  WORKER_EGRESS_WARN_INTERVAL_MS,
} from './client-ip-throttler.guard';
import { PartnerThrottlerGuard } from './partner-throttler.guard';

/**
 * AUDIT S3. `trust proxy` to'liq yoqilgani uchun `req.ip` mijozning o'z
 * `X-Forwarded-For` qiymatidan kelib chiqardi — ya'ni har so'rovda boshqa IP
 * ko'rsatib, login uchun qo'yilgan daqiqasiga 10 ta urinish chegarasini ham
 * aylanib o'tish mumkin edi.
 */
describe('ClientIpThrottlerGuard', () => {
  const guard = Object.create(
    ClientIpThrottlerGuard.prototype,
  ) as ClientIpThrottlerGuard & {
    getTracker: (req: Record<string, unknown>) => Promise<string>;
  };

  it('soxtalashtirib bo`lmaydigan CF-Connecting-IP ni oladi', async () => {
    const tracker = await guard.getTracker({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      // Mijoz o'zi yozgan qiymat — e'tiborga olinmaydi.
      ip: '10.0.0.1',
    });
    expect(tracker).toBe('203.0.113.7');
  });

  it('sarlavha bo`lmasa req.ip ga qaytadi (lokal/ichki chaqiruv)', async () => {
    const tracker = await guard.getTracker({ headers: {}, ip: '10.0.0.1' });
    expect(tracker).toBe('10.0.0.1');
  });

  it('bo`sh sarlavhani ishonchli deb qabul qilmaydi', async () => {
    const tracker = await guard.getTracker({
      headers: { 'cf-connecting-ip': '   ' },
      ip: '10.0.0.1',
    });
    expect(tracker).toBe('10.0.0.1');
  });
});

/**
 * Bir domenli API (kabinet Worker proksisi, docs/ops/same-origin-api.md):
 * Worker API'ga BOSHQA Cloudflare zonasidan murojaat qilsa `CF-Connecting-IP`
 * hamma uchun `2a06:98c0:3600::103` — bitta login chegarasi hamma uchun.
 * Xatti-harakat o'zgarmaydi, lekin holat jimgina o'tmaydi (ogohlantirish).
 */
describe('Cloudflare Worker umumiy manzili (CF-Connecting-IP)', () => {
  const guard = Object.create(
    ClientIpThrottlerGuard.prototype,
  ) as ClientIpThrottlerGuard & {
    getTracker: (req: Record<string, unknown>) => Promise<string>;
  };

  it('har qanday IPv6 yozilishida taniladi; boshqa IP / bo`sh — yo`q', () => {
    for (const ip of [
      CLOUDFLARE_WORKER_EGRESS_IP,
      ' 2A06:98C0:3600::103 ',
      '2a06:98c0:3600:0:0:0:0:103',
      '2a06:98c0:3600:0000:0000:0000:0000:0103',
    ]) {
      expect(isCloudflareWorkerEgressIp(ip)).toBe(true);
    }
    for (const ip of [
      '2a06:98c0:3600::104',
      '2a06:98c0:3601::103',
      '203.0.113.7',
      '::ffff:203.0.113.7',
      'not-an-ip',
      '',
      null,
      undefined,
    ]) {
      expect(isCloudflareWorkerEgressIp(ip)).toBe(false);
    }
  });

  it('rate-limit kaliti o`zgarmaydi (soxta XFF ga qaytilmaydi)', async () => {
    const tracker = await guard.getTracker({
      headers: {
        'cf-connecting-ip': CLOUDFLARE_WORKER_EGRESS_IP,
        'x-forwarded-for': '6.6.6.6',
      },
      ip: '6.6.6.6',
    });
    expect(tracker).toBe(CLOUDFLARE_WORKER_EGRESS_IP);
  });

  it('ogohlantirish: oddiy IP — yo`q; Worker manzili — oraliqda bir marta, o`tkazilganlar soni bilan', () => {
    let now = 1_000_000;
    const messages: string[] = [];
    const check = createWorkerEgressIpWarner(
      (message) => messages.push(message),
      60_000,
      () => now,
    );

    check('203.0.113.7');
    check(undefined);
    expect(messages).toHaveLength(0);

    check(CLOUDFLARE_WORKER_EGRESS_IP);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(CLOUDFLARE_WORKER_EGRESS_IP);
    expect(messages[0]).toContain('API_ORIGIN');
    expect(messages[0]).not.toContain('Oldingi');

    now += 30_000;
    check(CLOUDFLARE_WORKER_EGRESS_IP);
    check(CLOUDFLARE_WORKER_EGRESS_IP);
    expect(messages).toHaveLength(1);

    now += 30_000;
    check(CLOUDFLARE_WORKER_EGRESS_IP);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('yana 2 ta');

    now += 60_000;
    check(CLOUDFLARE_WORKER_EGRESS_IP);
    expect(messages).toHaveLength(3);
    expect(messages[2]).not.toContain('Oldingi');
  });

  it('sukut oraliq — 5 daqiqa', () => {
    expect(WORKER_EGRESS_WARN_INTERVAL_MS).toBe(300_000);
  });
});

describe('PartnerThrottlerGuard', () => {
  const guard = Object.create(
    PartnerThrottlerGuard.prototype,
  ) as PartnerThrottlerGuard & {
    getTracker: (req: Record<string, unknown>) => Promise<string>;
  };

  it('hamkor aniqlansa uning ID si bo`yicha sanaydi', async () => {
    const tracker = await guard.getTracker({
      partner: { id: '9' },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(tracker).toBe('partner-9');
  });

  it('hamkorsiz holatda ishonchli IP ga qaytadi', async () => {
    const tracker = await guard.getTracker({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '10.0.0.1',
    });
    expect(tracker).toBe('203.0.113.7');
  });
});
