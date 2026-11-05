import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * GykuOz8f — kuryer ro'yxatidagi «Tasdiq kutilmoqda» belgisi serverdan
 * (localStorage emas — har qurilmada bir xil): buyurtma javobida
 * `pending_extra_cost_approval: { id, action, amount, created_at,
 * auto_approve_at } | null`.
 *
 *  - faqat «kutilmoqda» (`waiting`) buyurtma va o'chirilmagan ochiq so'rov;
 *  - sahifaga BITTA so'rov (boshqa holatdagi buyurtma so'ralmaydi);
 *  - so'rov xatosi boyitishni yiqitmaydi — belgi `null`.
 * Haqiqiy SQL — `extra-cost-page.GykuOz8f.pg.spec.ts`.
 */
type Row = Record<string, unknown>;

const ROWS = [
  { id: '73', status: 'waiting' },
  { id: '74', status: 'waiting' },
  { id: '72', status: 'sold' },
  { id: '71', status: 'cancelled' },
].map((row) => ({
  market_id: '37',
  customer_id: null,
  district_id: null,
  region_id: null,
  courier_id: null,
  post_id: null,
  where_deliver: 'center',
  total_price: 50000,
  paid_online_amount: 0,
  paid_amount: 0,
  items: [],
  ...row,
}));

function build(query: jest.Mock) {
  const client = () => ({ send: jest.fn(() => of({ data: [] })) });
  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  Object.assign(service, {
    identityClient: client(),
    logisticsClient: client(),
    catalogClient: client(),
    dataSource: { query },
    logger,
  });
  jest.spyOn(service, 'findAll').mockResolvedValue({
    data: ROWS,
    total: ROWS.length,
    page: 1,
    limit: 20,
    total_pages: 1,
    totalPages: 1,
  } as never);
  return { service, logger };
}

const pendingCalls = (query: jest.Mock) =>
  (query.mock.calls as unknown[][]).filter(([sql]) =>
    String(sql).includes('order_extra_cost_approvals'),
  );

const flags = async (service: OrderServiceService) => {
  const res = await service.findAllEnriched({});
  return new Map(
    (res.data as unknown as Row[]).map((row) => [
      String(row.id),
      row.pending_extra_cost_approval,
    ]),
  );
};

afterEach(() => jest.restoreAllMocks());

describe('GykuOz8f — pending_extra_cost_approval (buyurtma javobida)', () => {
  it('⭐ kutilayotgan buyurtmada ochiq so‘rov bor — belgi; yo‘q yoki boshqa holat — null; BITTA so‘rov', async () => {
    const createdAt = new Date('2026-11-05T08:00:00Z');
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('order_extra_cost_approvals')
          ? [
              {
                id: '9',
                order_id: '73',
                action: 'sell',
                amount: '12000',
                status: 'pending',
                createdAt,
                auto_approve_from: createdAt,
                auto_retry_at: null,
                reminder_sent_at: null,
              },
            ]
          : [],
      ),
    );
    const { service } = build(query);

    const byId = await flags(service);

    expect(byId.get('73')).toEqual({
      id: '9',
      action: 'sell',
      amount: 12000,
      created_at: '2026-11-05T08:00:00.000Z',
      auto_approve_at: expect.any(String),
    });
    expect(byId.get('74')).toBeNull();
    expect(byId.get('72')).toBeNull();
    expect(byId.get('71')).toBeNull();

    const calls = pendingCalls(query);
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0] as [string, unknown[]];
    // Faqat «kutilmoqda» buyurtmalar so'raladi.
    expect(params).toEqual([['73', '74']]);
    expect(sql).toMatch(/"status" = 'pending'/);
    expect(sql).toMatch(/"is_deleted" = false/);
    expect(sql).toMatch(/"order_id" = ANY\(\$1::bigint\[\]\)/);
  });

  it('sahifada kutilayotgan buyurtma yo‘q — so‘rov ketmaydi, hammasi null', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = build(query);
    jest.spyOn(service, 'findAll').mockResolvedValue({
      data: ROWS.filter((row) => row.status !== 'waiting'),
      total: 2,
      page: 1,
      limit: 20,
      total_pages: 1,
      totalPages: 1,
    } as never);

    const byId = await flags(service);

    expect(pendingCalls(query)).toHaveLength(0);
    expect([...byId.values()]).toEqual([null, null]);
  });

  it('⭐ so‘rov xatosi — boyitish yiqilmaydi, belgi null (ogohlantirish)', async () => {
    const query = jest.fn((sql: string) =>
      sql.includes('order_extra_cost_approvals')
        ? Promise.reject(new Error('relation does not exist'))
        : Promise.resolve([]),
    );
    const { service, logger } = build(query);

    const byId = await flags(service);

    expect(byId.get('73')).toBeNull();
    expect(byId.get('72')).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('relation does not exist'),
    );
  });
});
