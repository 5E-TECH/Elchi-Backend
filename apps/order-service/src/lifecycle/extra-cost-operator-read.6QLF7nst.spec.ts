import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 6QLF7nst — `GET orders/extra-cost-approvals` MARKET_OPERATOR uchun FAQAT
 * o'qish: o'zi biriktirilgan market (gateway identity'dan `requester.market_id`
 * qo'yadi) so'rovlari. Tasdiqlash/rad etish operatorga yopiq qoladi.
 */
type Row = Record<string, any>;

const approvalRow = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '76',
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  action: 'sell',
  amount: 12000,
  status: 'pending',
  isDeleted: false,
  createdAt: new Date('2026-10-24T08:00:00Z'),
  updatedAt: new Date('2026-10-24T08:00:00Z'),
  ...overrides,
});

/** `repo.find` ga uzatilgan `where`. */
const findWhere = (repo: { find: jest.Mock }) =>
  (repo.find.mock.calls as Array<[{ where: Row }]>)[0][0].where;

function makeService() {
  const row = approvalRow();
  const repo = {
    find: jest.fn().mockResolvedValue([row]),
    findOne: jest.fn().mockResolvedValue(row),
    createQueryBuilder: jest.fn(),
  };
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, { extraCostApprovalRepo: repo });
  const sellOrder = jest.spyOn(svc, 'sellOrder');
  return { svc, repo, sellOrder };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ statusCode: 200 }),
    (error: unknown) =>
      (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      },
  );

afterEach(() => jest.restoreAllMocks());

describe('6QLF7nst — extra-cost ro‘yxati MARKET_OPERATOR uchun (faqat o‘qish)', () => {
  it('⭐ operator — faqat o‘z marketi (requester.market_id), requester.id emas', async () => {
    const { svc, repo } = makeService();

    const res = (await svc.listExtraCostApprovals(
      { id: '26', roles: ['market_operator'], market_id: '501' },
      { status: 'pending' },
    )) as { statusCode: number; data: unknown[] };

    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveLength(1);
    expect(findWhere(repo)).toEqual({
      status: 'pending',
      isDeleted: false,
      market_id: '501',
    });
  });

  it('operator marketga biriktirilmagan (market_id yo‘q) — 403, DB o‘qilmaydi', async () => {
    const { svc, repo } = makeService();

    expect(
      await errorOf(
        svc.listExtraCostApprovals({ id: '26', roles: ['market_operator'] }),
      ),
    ).toEqual({
      statusCode: 403,
      message: 'Operator hech qaysi marketga biriktirilmagan',
    });
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('market — o‘zgarishsiz: requester.id (market_id yuborilsa ham e’tiborsiz)', async () => {
    const { svc, repo } = makeService();

    await svc.listExtraCostApprovals({
      id: '501',
      roles: ['market'],
      market_id: '999',
    });

    expect(findWhere(repo).market_id).toBe('501');
  });

  it('superadmin — o‘zgarishsiz (market filtrsiz)', async () => {
    const { svc, repo } = makeService();

    await svc.listExtraCostApprovals({ id: '1', roles: ['superadmin'] });

    expect(findWhere(repo)).not.toHaveProperty('market_id');
  });

  it('boshqa rol (kuryer) — avvalgidek 403', async () => {
    const { svc } = makeService();

    expect(
      (
        await errorOf(
          svc.listExtraCostApprovals({ id: '301', roles: ['courier'] }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it('⭐ operator TASDIQLAY olmaydi — 403, sotuv bajarilmaydi', async () => {
    const { svc, sellOrder } = makeService();

    expect(
      await errorOf(
        svc.approveExtraCostApproval(
          { id: '26', roles: ['market_operator'] },
          '7',
        ),
      ),
    ).toEqual({
      statusCode: 403,
      message: "Bu qo'shimcha xarajat so'rovini tasdiqlash mumkin emas",
    });
    expect(sellOrder).not.toHaveBeenCalled();
  });

  it('⭐ operator RAD eta olmaydi — 403', async () => {
    const { svc, repo } = makeService();

    expect(
      (
        await errorOf(
          svc.rejectExtraCostApproval(
            { id: '26', roles: ['market_operator'] },
            '7',
            {},
          ),
        )
      ).statusCode,
    ).toBe(403);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
