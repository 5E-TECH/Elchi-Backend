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
      // Skaner belgilagan muddat boshi (yangi so'rov — createdAt).
      auto_approve_from: new Date('2026-10-17T12:42:00.000Z'),
      ...approval,
    });
  const saved = process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
  const savedReminder = process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES;
  // Ko'rsatiladigan muddat eslatma holatiga ham bog'liq — soat so'rovdan
  // 8 daqiqa keyin (eslatma hali vaqti kelmagan).
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-17T12:50:00.000Z') }),
  );
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    else process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = saved;
    if (savedReminder === undefined)
      delete process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES;
    else process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES = savedReminder;
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

  it('⭐ (AFZaUUi5) skaner hali belgilamagan (NULL): yosh so‘rov — createdAt dan, muddatdan eski — hozirdan', () => {
    delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    jest.setSystemTime(new Date('2026-10-17T14:00:00.000Z'));
    expect(
      serialize({ status: 'pending', auto_approve_from: null }).auto_approve_at,
    ).toBe('2026-10-18T12:42:00.000Z');
    expect(
      serialize({
        status: 'pending',
        auto_approve_from: null,
        createdAt: new Date('2026-10-14T12:42:00.000Z'),
      }).auto_approve_at,
    ).toBe('2026-10-18T14:00:00.000Z');
  });

  it('⭐ (AFZaUUi5) eslatma o‘z vaqtida ketgan — muddat o‘zgarmaydi (so‘rov vaqti + N)', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    jest.setSystemTime(new Date('2026-10-17T13:05:00.000Z'));
    // Eslatma 13:02 da (muddatdan 10 daqiqa oldin), tik 40 soniya kechikkan.
    expect(
      serialize({
        status: 'pending',
        reminder_sent_at: new Date('2026-10-17T13:02:40.000Z'),
      }).auto_approve_at,
    ).toBe('2026-10-17T13:12:00.000Z');
  });

  it('⭐ (AFZaUUi5) eslatma kech ketgan — tasdiq eslatmadan 10 daqiqa keyin, muddat ham shu', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    jest.setSystemTime(new Date('2026-10-17T13:25:00.000Z'));
    expect(
      serialize({
        status: 'pending',
        reminder_sent_at: new Date('2026-10-17T13:20:00.000Z'),
      }).auto_approve_at,
    ).toBe('2026-10-17T13:30:00.000Z');
  });

  it('⭐ (AFZaUUi5) muddat o‘tgan, eslatma hali ketmagan — hozir + 10 daqiqadan oldin emas', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    jest.setSystemTime(new Date('2026-10-17T13:30:00.000Z'));
    expect(serialize({ status: 'pending' }).auto_approve_at).toBe(
      '2026-10-17T13:40:00.000Z',
    );
    // Eslatma o'chiq (muddatdan kichik emas) — skaner eslatma kutmaydi.
    process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES = '30';
    expect(serialize({ status: 'pending' }).auto_approve_at).toBe(
      '2026-10-17T13:12:00.000Z',
    );
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
