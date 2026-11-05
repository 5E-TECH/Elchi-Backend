import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 1tnpaIqd (ega qarori — muddat) — kutilayotgan qo'shimcha xarajat so'rovida
 * `auto_approve_at`: market shu vaqtgacha javob bermasa so'rov avtomatik
 * tasdiqlanadi. Frontend market kabinetida muddatni ko'rsatadi.
 */
describe('1tnpaIqd — extra-cost auto_approve_at', () => {
  const service = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  const serialize = (approval: Record<string, unknown>) =>
    (
      service as unknown as {
        serializeExtraCostApproval: (a: unknown) => {
          auto_approve_at: unknown;
        };
      }
    ).serializeExtraCostApproval({
      id: '3',
      order_id: '76',
      market_id: '37',
      requested_by_user_id: '26',
      amount: 3000,
      createdAt: new Date('2026-10-17T12:42:00.000Z'),
      updatedAt: new Date('2026-10-17T12:42:00.000Z'),
      ...approval,
    });
  const saved = process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    else process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = saved;
  });

  it('⭐ yoqilgan: kutilayotgan so‘rovda createdAt + N daqiqa', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    expect(serialize({ status: 'pending' }).auto_approve_at).toBe(
      '2026-10-17T13:12:00.000Z',
    );
  });

  it('⭐ (AFZaUUi5) env yo‘q, bo‘sh yoki noto‘g‘ri — sukut 24 soat', () => {
    for (const raw of [undefined, '', '0', 'abc']) {
      if (raw === undefined) delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
      else process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = raw;
      expect(serialize({ status: 'pending' }).auto_approve_at).toBe(
        '2026-10-18T12:42:00.000Z',
      );
    }
  });

  it('⭐ (AFZaUUi5) muddat `auto_approve_from` dan sanaladi (yoqilgan paytda ochiq turgan so‘rov)', () => {
    delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    expect(
      serialize({
        status: 'pending',
        auto_approve_from: new Date('2026-11-05T05:00:00.000Z'),
      }).auto_approve_at,
    ).toBe('2026-11-06T05:00:00.000Z');
  });

  it('(AFZaUUi5) avtomatik urinish kechiktirilgan — keyingi urinish vaqti', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    expect(
      serialize({
        status: 'pending',
        auto_retry_at: new Date('2026-10-17T14:00:00.000Z'),
      }).auto_approve_at,
    ).toBe('2026-10-17T14:00:00.000Z');
    // Kechiktirish muddatdan oldin bo'lsa — muddat.
    expect(
      serialize({
        status: 'pending',
        auto_retry_at: new Date('2026-10-17T13:00:00.000Z'),
      }).auto_approve_at,
    ).toBe('2026-10-17T13:12:00.000Z');
  });

  it('yopilgan so‘rov (approved / rejected / void / reversed) — null', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    for (const status of ['approved', 'rejected', 'void', 'reversed']) {
      expect(serialize({ status }).auto_approve_at).toBeNull();
    }
  });
});
