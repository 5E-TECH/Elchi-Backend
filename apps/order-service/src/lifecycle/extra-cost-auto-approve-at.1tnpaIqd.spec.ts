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

  it('o‘chiq yoki noto‘g‘ri qiymat — null', () => {
    delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    expect(serialize({ status: 'pending' }).auto_approve_at).toBeNull();
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '0';
    expect(serialize({ status: 'pending' }).auto_approve_at).toBeNull();
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = 'abc';
    expect(serialize({ status: 'pending' }).auto_approve_at).toBeNull();
  });

  it('yopilgan so‘rov (approved / rejected) — null', () => {
    process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = '30';
    expect(serialize({ status: 'approved' }).auto_approve_at).toBeNull();
    expect(serialize({ status: 'rejected' }).auto_approve_at).toBeNull();
  });
});
