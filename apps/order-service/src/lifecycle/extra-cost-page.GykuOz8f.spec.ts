import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { Order } from '../entities/order.entity';
import {
  buildExtraCostCounts,
  extraCostScopeWhere,
  parseExtraCostTab,
  pendingExtraCostApprovalView,
  resolveExtraCostScope,
} from './extra-cost-page';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * GykuOz8f — «Qo'shimcha xarajatli buyurtmalar» sahifasi (order-service).
 *
 *  - ko'rish doirasi FAQAT token ma'lumotidan: kuryer — o'zi yozganlari;
 *    menejer — filial kuryerlari + o'zi (filialsiz — faqat o'zi); market —
 *    o'z marketi; market operatori — biriktirilgan market (faqat o'qish),
 *    biriktirilmagan — 403; admin / superadmin — 403;
 *  - tablar: `all`, `pending`, `approved`, `cancelled` (rejected + void),
 *    `counts` — bitta GROUP BY, haqiqiy sahifalash (`createdAt` DESC, id DESC);
 *  - qator: buyurtma holati, mijoz, market nomi, isbotlar soni, rad sababi —
 *    ismlar BITTA, mijozlar BITTA identity chaqiruvida;
 *  - isbot: ro'yxat bilan AYNI ko'rish qoidasi, aks holda 404.
 * Haqiqiy SQL — `extra-cost-page.GykuOz8f.pg.spec.ts`.
 */
type Row = Record<string, unknown>;
type Call = [string, unknown[]];

const COURIER = { id: '301', roles: ['courier'], branch_id: '77' };
const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };
const MARKET = { id: '501', roles: ['market'] };
const OPERATOR = { id: '26', roles: ['market_operator'], market_id: '501' };

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode: number;
    message: string;
  };
};

const approval = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '7001',
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  action: 'sell',
  amount: 10000,
  proof_file_keys: ['proof/a.jpg', 'proof/b.mp4'],
  operation_payload: { extraCost: 10000 },
  status: 'pending',
  immediate: false,
  auto_approved: false,
  isDeleted: false,
  createdAt: new Date('2026-11-05T08:00:00Z'),
  updatedAt: new Date('2026-11-05T08:00:00Z'),
  ...overrides,
});

describe('GykuOz8f — ko‘rish doirasi (resolveExtraCostScope)', () => {
  it('kuryer — faqat o‘zi yozganlari', () => {
    const scope = resolveExtraCostScope(COURIER);
    expect(scope).toEqual({ kind: 'courier', userId: '301' });
    expect(extraCostScopeWhere(scope)).toEqual({
      sql: 'a.requested_by_user_id = :scopeUserId',
      params: { scopeUserId: '301' },
    });
  });

  it('⭐ menejer — o‘z filiali kuryerlari (so‘rov paytidagi filial) VA o‘zi yozganlari', () => {
    const scope = resolveExtraCostScope(MANAGER);
    expect(scope).toEqual({ kind: 'manager', userId: '201', branchId: '77' });
    expect(extraCostScopeWhere(scope)).toEqual({
      sql:
        '((a.requester_branch_id = :scopeBranchId AND a.requested_by_role = :scopeCourierRole)' +
        ' OR a.requested_by_user_id = :scopeUserId)',
      params: {
        scopeBranchId: '77',
        scopeCourierRole: 'courier',
        scopeUserId: '201',
      },
    });
  });

  it('filialsiz menejer — faqat o‘zi yozganlari', () => {
    const scope = resolveExtraCostScope({ id: '201', roles: ['manager'] });
    expect(scope).toEqual({ kind: 'manager', userId: '201', branchId: null });
    expect(extraCostScopeWhere(scope)).toEqual({
      sql: 'a.requested_by_user_id = :scopeUserId',
      params: { scopeUserId: '201' },
    });
  });

  it('market — o‘z marketi (id tokendan)', () => {
    const scope = resolveExtraCostScope(MARKET);
    expect(scope).toEqual({ kind: 'market', marketId: '501', readOnly: false });
    expect(extraCostScopeWhere(scope, 'x')).toEqual({
      sql: 'x.market_id = :scopeMarketId',
      params: { scopeMarketId: '501' },
    });
  });

  it('⭐ market operatori — gateway qo‘ygan market, faqat o‘qish; biriktirilmagan — 403', () => {
    expect(resolveExtraCostScope(OPERATOR)).toEqual({
      kind: 'market',
      marketId: '501',
      readOnly: true,
    });
    for (const marketId of [undefined, null, '', 'abc']) {
      expect(() =>
        resolveExtraCostScope({
          id: '26',
          roles: ['market_operator'],
          market_id: marketId,
        }),
      ).toThrow(RpcException);
    }
  });

  it('⭐ admin / superadmin / boshqa rol / id’siz — 403', () => {
    for (const requester of [
      { id: '1', roles: ['superadmin'] },
      { id: '2', roles: ['admin'] },
      // Admin roli ustun: qo'shimcha rol doirani ochmaydi.
      { id: '3', roles: ['admin', 'courier'] },
      { id: '4', roles: ['registrator'] },
      { id: 'partner:4', roles: ['courier'] },
      { id: '', roles: ['courier'] },
    ]) {
      let error: unknown = null;
      try {
        resolveExtraCostScope(requester);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 403,
      });
    }
    expect(() => resolveExtraCostScope(null)).toThrow(RpcException);
  });

  it('rollar katta harf / bo‘sh joy bilan ham tanadi', () => {
    expect(resolveExtraCostScope({ id: '301', roles: [' Courier '] })).toEqual({
      kind: 'courier',
      userId: '301',
    });
  });
});

describe('GykuOz8f — tablar va sonlar', () => {
  it('parseExtraCostTab: bo‘sh — all, noma’lum — null', () => {
    expect(parseExtraCostTab(undefined)).toBe('all');
    expect(parseExtraCostTab('')).toBe('all');
    expect(parseExtraCostTab(' Pending ')).toBe('pending');
    expect(parseExtraCostTab('cancelled')).toBe('cancelled');
    expect(parseExtraCostTab('rejected')).toBeNull();
    expect(parseExtraCostTab(['all'])).toBeNull();
  });

  it('⭐ buildExtraCostCounts: cancelled = rejected + void; reversed faqat «all» da', () => {
    expect(
      buildExtraCostCounts([
        { status: 'pending', count: 3 },
        { status: 'approved', count: '4' },
        { status: 'rejected', count: 2 },
        { status: 'void', count: 1 },
        { status: 'reversed', count: 5 },
      ]),
    ).toEqual({ all: 15, pending: 3, approved: 4, cancelled: 3 });
    expect(buildExtraCostCounts([])).toEqual({
      all: 0,
      pending: 0,
      approved: 0,
      cancelled: 0,
    });
  });
});

/**
 * Soxta QueryBuilder: har bir qurilgan so'rovning chaqiruvlari yoziladi
 * (doira sharti, tab filtri, tartib, offset/limit).
 */
function fakeRepo(config: {
  grouped?: Row[];
  entities?: Row[];
  raw?: Row[];
  one?: Row | null;
}) {
  const built: Call[][] = [];
  const createQueryBuilder = jest.fn((alias: string) => {
    const calls: Call[] = [['createQueryBuilder', [alias]]];
    built.push(calls);
    const qb: Record<string, unknown> = {};
    for (const name of [
      'innerJoin',
      'where',
      'andWhere',
      'select',
      'addSelect',
      'groupBy',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
    ]) {
      qb[name] = (...args: unknown[]) => {
        calls.push([name, args]);
        return qb;
      };
    }
    qb.getRawMany = jest.fn(() => Promise.resolve(config.grouped ?? []));
    qb.getRawAndEntities = jest.fn(() =>
      Promise.resolve({
        entities: config.entities ?? [],
        raw: config.raw ?? [],
      }),
    );
    qb.getOne = jest.fn(() => Promise.resolve(config.one ?? null));
    return qb;
  });
  return { repo: { createQueryBuilder }, built };
}

const of_ = (calls: Call[], name: string) =>
  calls.filter(([n]) => n === name).map(([, args]) => args);

type PageRes = {
  statusCode: number;
  message: string;
  data: {
    items: Row[];
    total: number;
    page: number;
    limit: number;
    counts: Record<string, number>;
  };
};

function makeService(
  config: Parameters<typeof fakeRepo>[0],
  identitySend: jest.Mock = jest.fn(
    (pattern: { cmd: string }, payload: { ids: string[] }) => {
      if (pattern.cmd === 'identity.user.find_by_ids') {
        return of({
          data: [
            { id: '301', name: 'Ali Kuryer' },
            { id: '501', name: 'TEST Market' },
          ].filter((user) => payload.ids.includes(user.id)),
        });
      }
      if (pattern.cmd === 'identity.customer.find_by_ids') {
        return of({
          data: [
            { id: '801', name: 'Mijoz Bir', phone_number: '+998901112233' },
            { id: '802', name: 'Mijoz Ikki', phone_number: null },
          ].filter((customer) => payload.ids.includes(customer.id)),
        });
      }
      return of({ data: [] });
    },
  ),
) {
  const { repo, built } = fakeRepo(config);
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, {
    extraCostApprovalRepo: repo,
    identityClient: { send: identitySend },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return { svc, built, identitySend, repo };
}

describe('GykuOz8f — pageExtraCosts', () => {
  const grouped = [
    { status: 'pending', count: 25 },
    { status: 'approved', count: 3 },
    { status: 'rejected', count: 1 },
    { status: 'reversed', count: 1 },
  ];

  it('⭐ kuryer, «pending» tab, 2-sahifa: doira, tab filtri, tartib, offset/limit va counts', async () => {
    const { svc, built } = makeService({ grouped });

    const res: PageRes = await svc.pageExtraCosts(COURIER, {
      tab: 'pending',
      page: 2,
      limit: 10,
    });

    expect(res).toMatchObject({
      statusCode: 200,
      message: 'Extra costs',
      data: {
        items: [],
        total: 25,
        page: 2,
        limit: 10,
        counts: { all: 30, pending: 25, approved: 3, cancelled: 1 },
      },
    });
    expect(built).toHaveLength(2);
    for (const calls of built) {
      // O'chirilgan so'rov va o'chirilgan buyurtmaniki ko'rinmaydi.
      expect(of_(calls, 'innerJoin')).toEqual([
        [Order, 'o', 'o.id = a.order_id AND o.is_deleted = false'],
      ]);
      expect(of_(calls, 'where')).toEqual([['a.is_deleted = false']]);
      expect(of_(calls, 'andWhere')[0]).toEqual([
        'a.requested_by_user_id = :scopeUserId',
        { scopeUserId: '301' },
      ]);
    }
    const [counts, page] = built;
    // Sonlar — BITTA GROUP BY (tab filtrisiz).
    expect(of_(counts, 'groupBy')).toEqual([['a.status']]);
    expect(of_(counts, 'andWhere')).toHaveLength(1);
    expect(of_(page, 'andWhere')[1]).toEqual([
      'a.status IN (:...tabStatuses)',
      { tabStatuses: ['pending'] },
    ]);
    expect(of_(page, 'orderBy')).toEqual([['a.createdAt', 'DESC']]);
    expect(of_(page, 'addOrderBy')).toEqual([['a.id', 'DESC']]);
    expect(of_(page, 'offset')).toEqual([[10]]);
    expect(of_(page, 'limit')).toEqual([[10]]);
  });

  it('«cancelled» — rejected + void; «all» — status filtrisiz', async () => {
    const cancelled = makeService({ grouped });
    await cancelled.svc.pageExtraCosts(MARKET, { tab: 'cancelled' });
    expect(of_(cancelled.built[1], 'andWhere')).toEqual([
      ['a.market_id = :scopeMarketId', { scopeMarketId: '501' }],
      ['a.status IN (:...tabStatuses)', { tabStatuses: ['rejected', 'void'] }],
    ]);

    const all = makeService({ grouped });
    const res: PageRes = await all.svc.pageExtraCosts(MARKET, {});
    expect(res.data).toMatchObject({ total: 30, page: 1, limit: 10 });
    expect(of_(all.built[1], 'andWhere')).toEqual([
      ['a.market_id = :scopeMarketId', { scopeMarketId: '501' }],
    ]);
  });

  it('sahifa jami sondan tashqarida — qatorlar so‘rovi umuman yo‘q, items bo‘sh', async () => {
    const { svc, built, identitySend } = makeService({ grouped });

    const res: PageRes = await svc.pageExtraCosts(COURIER, {
      tab: 'approved',
      page: 2,
      limit: 10,
    });

    expect(res.data).toMatchObject({ items: [], total: 3, page: 2 });
    expect(built).toHaveLength(1);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('page / limit chegaralanadi (page ≥ 1, limit ≤ 100)', async () => {
    const { svc, built } = makeService({
      grouped: [{ status: 'pending', count: 500 }],
    });

    const res: PageRes = await svc.pageExtraCosts(COURIER, {
      tab: 'all',
      page: 0,
      limit: 500,
    });

    expect(res.data).toMatchObject({ page: 1, limit: 100, total: 500 });
    expect(of_(built[1], 'offset')).toEqual([[0]]);
    expect(of_(built[1], 'limit')).toEqual([[100]]);
  });

  it('⭐ noma’lum tab — 400 «Noto‘g‘ri tab»; admin / superadmin — 403; so‘rov ketmaydi', async () => {
    const { svc, built } = makeService({ grouped });

    expect(
      await rpcError(svc.pageExtraCosts(COURIER, { tab: 'rejected' })),
    ).toEqual({ statusCode: 400, message: "Noto'g'ri tab" });
    for (const roles of [['admin'], ['superadmin']]) {
      expect(
        await rpcError(svc.pageExtraCosts({ id: '1', roles }, { tab: 'all' })),
      ).toMatchObject({ statusCode: 403 });
    }
    expect(
      await rpcError(
        svc.pageExtraCosts({ id: '26', roles: ['market_operator'] }, {}),
      ),
    ).toEqual({
      statusCode: 403,
      message: 'Operator hech qaysi marketga biriktirilmagan',
    });
    expect(built).toHaveLength(0);
  });

  it('⭐ menejer va operator doirasi so‘rovga tushadi', async () => {
    const manager = makeService({ grouped });
    await manager.svc.pageExtraCosts(MANAGER, {});
    expect(of_(manager.built[0], 'andWhere')[0]).toEqual([
      '((a.requester_branch_id = :scopeBranchId AND a.requested_by_role = :scopeCourierRole)' +
        ' OR a.requested_by_user_id = :scopeUserId)',
      { scopeBranchId: '77', scopeCourierRole: 'courier', scopeUserId: '201' },
    ]);

    const operator = makeService({ grouped });
    await operator.svc.pageExtraCosts(OPERATOR, {});
    expect(of_(operator.built[0], 'andWhere')[0]).toEqual([
      'a.market_id = :scopeMarketId',
      { scopeMarketId: '501' },
    ]);
  });

  const pageRows = () => {
    const entities = [
      approval({ id: '9', immediate: true, status: 'approved' }),
      approval({
        id: '8',
        order_id: '7002',
        status: 'rejected',
        reject_reason: 'TOO_EXPENSIVE',
        decision_comment: 'Summa juda katta — Juda qimmat',
        proof_file_keys: [],
      }),
      approval({ id: '7', order_id: '7003', requested_by_user_id: '302' }),
    ];
    const raw = [
      {
        a_id: '9',
        order_status: 'sold',
        order_customer_id: '801',
        order_extra_number: null,
      },
      {
        a_id: '8',
        order_status: 'waiting',
        order_customer_id: '802',
        order_extra_number: '+998907770000',
      },
      {
        a_id: '7',
        order_status: 'waiting',
        order_customer_id: null,
        order_extra_number: null,
      },
    ];
    return { entities, raw };
  };

  it('⭐ qator: buyurtma holati, mijoz, market nomi (telefonsiz), isbotlar soni, rad sababi — identity BITTA + BITTA', async () => {
    const { svc, identitySend } = makeService({
      grouped: [
        { status: 'approved', count: 1 },
        { status: 'rejected', count: 1 },
        { status: 'pending', count: 1 },
      ],
      ...pageRows(),
    });

    const res: PageRes = await svc.pageExtraCosts(MARKET, {});

    expect(identitySend).toHaveBeenCalledTimes(2);
    const userCall = identitySend.mock.calls.find(
      ([pattern]: [{ cmd: string }]) =>
        pattern.cmd === 'identity.user.find_by_ids',
    );
    // So'rovchilar va market — bitta chaqiruvda, takrorsiz.
    expect([...(userCall[1] as { ids: string[] }).ids].sort()).toEqual([
      '301',
      '302',
      '501',
    ]);
    const customerCall = identitySend.mock.calls.find(
      ([pattern]: [{ cmd: string }]) =>
        pattern.cmd === 'identity.customer.find_by_ids',
    );
    expect([...(customerCall[1] as { ids: string[] }).ids].sort()).toEqual([
      '801',
      '802',
    ]);

    const [immediate, rejected, pending] = res.data.items;
    expect(immediate).toMatchObject({
      id: '9',
      order_id: '7001',
      order_number: 'EL-107001',
      status: 'approved',
      immediate: true,
      order_status: 'sold',
      customer: { name: 'Mijoz Bir', phone: '+998901112233' },
      market: { id: '501', name: 'TEST Market' },
      requested_by: { id: '301', name: 'Ali Kuryer' },
      proof_count: 2,
      reject_reason_label: null,
    });
    // Mijoz kartasida telefon yo'q — buyurtmadagi qo'shimcha raqam.
    expect(rejected).toMatchObject({
      id: '8',
      order_status: 'waiting',
      customer: { name: 'Mijoz Ikki', phone: '+998907770000' },
      proof_count: 0,
      reject_reason: 'TOO_EXPENSIVE',
      reject_reason_label: 'Summa juda katta',
      decision_comment: 'Summa juda katta — Juda qimmat',
    });
    expect(pending).toMatchObject({
      id: '7',
      immediate: false,
      customer: null,
      requested_by: { id: '302', name: null },
    });
    expect(pending.auto_approve_at).toEqual(expect.any(String));
    // Market telefoni kuryer / menejerga chiqmaydi.
    expect(Object.keys(immediate.market as Row).sort()).toEqual(['id', 'name']);
  });

  it('identity javob bermadi — sahifa baribir qaytadi, ism / mijoz ismi null', async () => {
    const { svc } = makeService(
      { grouped: [{ status: 'pending', count: 2 }], ...pageRows() },
      jest.fn(() => throwError(() => new Error('Timeout has occurred'))),
    );

    const res: PageRes = await svc.pageExtraCosts(COURIER, {});

    expect(res.data.items).toHaveLength(3);
    expect(res.data.items[0]).toMatchObject({
      requested_by: { name: null },
      market: { id: '501', name: null },
      customer: { name: null, phone: null },
    });
    expect(res.data.items[1]).toMatchObject({
      customer: { name: null, phone: '+998907770000' },
    });
  });
});

describe('GykuOz8f — extraCostProofKey (isbot fayli)', () => {
  type ProofRes = { data: { key: string; index: number; count: number } };

  it('⭐ ko‘rinadigan so‘rov — raqam bo‘yicha kalit; doira sharti + id', async () => {
    const { svc, built } = makeService({ one: approval({ status: 'void' }) });

    const res = (await svc.extraCostProofKey(OPERATOR, '7', '1')) as ProofRes;

    expect(res.data).toEqual({ key: 'proof/b.mp4', index: 1, count: 2 });
    expect(of_(built[0], 'andWhere')).toEqual([
      ['a.market_id = :scopeMarketId', { scopeMarketId: '501' }],
      ['a.id = :approvalId', { approvalId: '7' }],
    ]);
  });

  it('⭐ ko‘rinmaydigan so‘rov (boshqa kuryerniki / boshqa market) — 404 «So‘rov topilmadi»', async () => {
    const { svc } = makeService({ one: null });
    expect(await rpcError(svc.extraCostProofKey(COURIER, '7', 0))).toEqual({
      statusCode: 404,
      message: "So'rov topilmadi",
    });
  });

  it('raqam oraliqdan tashqarida yoki noto‘g‘ri — 404 «Isbot fayli topilmadi»', async () => {
    for (const index of [2, '2', -1, '-1', 'x', 1.5, null]) {
      const { svc } = makeService({ one: approval() });
      expect(
        await rpcError(svc.extraCostProofKey(COURIER, '7', index)),
      ).toEqual({ statusCode: 404, message: 'Isbot fayli topilmadi' });
    }
    // Isbotsiz so'rov.
    const empty = makeService({ one: approval({ proof_file_keys: null }) });
    expect(
      await rpcError(empty.svc.extraCostProofKey(COURIER, '7', 0)),
    ).toMatchObject({ statusCode: 404 });
  });

  it('id raqam emas — 404, so‘rov ketmaydi; admin — 403', async () => {
    const { svc, built } = makeService({ one: approval() });
    expect(
      await rpcError(svc.extraCostProofKey(COURIER, '7 OR 1=1', 0)),
    ).toEqual({ statusCode: 404, message: "So'rov topilmadi" });
    expect(
      await rpcError(
        svc.extraCostProofKey({ id: '1', roles: ['superadmin'] }, '7', 0),
      ),
    ).toMatchObject({ statusCode: 403 });
    expect(built).toHaveLength(0);
  });
});

describe('GykuOz8f — pending_extra_cost_approval ko‘rinishi', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('⭐ id, amal, summa, so‘rov vaqti va avtomatik tasdiq vaqti (sukut 24 soat)', () => {
    delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
    delete process.env.EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES;
    const createdAt = new Date(Date.now() - 60 * 60_000);

    expect(
      pendingExtraCostApprovalView({
        id: '7',
        action: 'cancel',
        amount: '15000',
        status: 'pending',
        createdAt,
        auto_approve_from: createdAt,
        auto_retry_at: null,
        reminder_sent_at: null,
      } as never),
    ).toEqual({
      id: '7',
      action: 'cancel',
      amount: 15000,
      created_at: createdAt.toISOString(),
      auto_approve_at: new Date(
        createdAt.getTime() + 1440 * 60_000,
      ).toISOString(),
    });
  });
});
