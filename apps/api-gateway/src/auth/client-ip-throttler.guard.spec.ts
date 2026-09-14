import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
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
