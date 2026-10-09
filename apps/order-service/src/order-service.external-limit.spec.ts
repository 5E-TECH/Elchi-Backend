import { OrderServiceService } from './order-service.service';

/**
 * PEc4BjVX — order-service ham sahifani 100 ga qirqardi: gateway 200 ga
 * ruxsat bersa ham skan ekrani faqat 100 ta posilka olardi va 101-posilka
 * "topilmadi" bo'lardi. Tashqi ro'yxat 200 gacha, qolganlari 100 da.
 */
describe('normalizePagination — max_limit (PEc4BjVX)', () => {
  const svc = Object.create(OrderServiceService.prototype);

  it('sukut: 200 so`ralsa 100 ga qirqiladi (umumiy ro`yxatlar o`zgarmagan)', () => {
    expect(svc.normalizePagination(1, 200).limit).toBe(100);
  });

  it('⭐ max_limit=200: 200 qaytadi', () => {
    expect(svc.normalizePagination(1, 200, false, 200).limit).toBe(200);
  });

  it('max_limit 500 dan oshmaydi', () => {
    expect(svc.normalizePagination(1, 5000, false, 10000).limit).toBe(500);
  });

  it('⭐ findAllExternal findAllEnriched ga max_limit=200 uzatadi', async () => {
    const s = Object.create(OrderServiceService.prototype);
    s.findAllEnriched = jest.fn().mockResolvedValue({ data: [] });
    await s.findAllExternal({ market_id: '121', limit: 200 });
    expect(s.findAllEnriched).toHaveBeenCalledWith(
      expect.objectContaining({
        max_limit: 200,
        source: 'external',
        limit: 200,
      }),
    );
  });
});
