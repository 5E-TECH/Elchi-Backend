import { PartnerThrottlerGuard } from './partner-throttler.guard';

describe('PartnerThrottlerGuard.getTracker', () => {
  // ThrottlerGuard konstruktorига haqiqiy dep kerak emas — faqat getTracker'ni sinaymiz.
  const guard = new PartnerThrottlerGuard(
    {} as any,
    {} as any,
    {} as any,
  ) as unknown as { getTracker(req: Record<string, any>): Promise<string> };

  it('hamkor bo‘yicha sanaydi (partner-<id>)', async () => {
    await expect(
      guard.getTracker({ partner: { id: '42' }, ip: '10.0.0.1' }),
    ).resolves.toBe('partner-42');
  });

  it('hamkor bo‘lmasa IP‘ga qaytadi', async () => {
    await expect(guard.getTracker({ ip: '10.0.0.9' })).resolves.toBe(
      '10.0.0.9',
    );
  });

  it('ikki har xil hamkor -> har xil tracker (mustaqil limit)', async () => {
    const a = await guard.getTracker({ partner: { id: '1' } });
    const b = await guard.getTracker({ partner: { id: '2' } });
    expect(a).not.toBe(b);
  });
});
