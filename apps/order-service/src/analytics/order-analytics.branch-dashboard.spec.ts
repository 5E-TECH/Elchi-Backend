import { Logger } from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { Order } from '../entities/order.entity';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * Filial paneli (menejer statistikasi) — `getBranchDashboardStats`.
 *
 * So'rov quruvchilar mock: har `createQueryBuilder(alias)` yangi QB beradi va
 * barcha chaqiruvlarni yozib boradi. `getQuery()` `(SUB:<alias>)` belgisini
 * qaytaradi; `expandedSql()` uni o'sha ichki QB ning shartlari bilan
 * almashtiradi — ya'ni tashqi so'rovning YAKUNIY SQL'i tekshiriladi.
 *
 * ⚠️ NEGA. Mock test Postgres xatolarini ko'rmaydi, lekin uch xil xato faqat
 * serverda chiqadi: (1) ichki so'rovdagi `:param` tashqi so'rovda ro'yxatga
 * olinmagan (TypeORM uni SQL'da o'z holicha qoldiradi); (2) bo'sh ro'yxat
 * uchun `IN ()`; (3) bitta skalyar `$N` ikki xil enum ustunida. Shu uchalasi
 * `postgresParamProblems` bilan har bir tashqi so'rovda tekshiriladi.
 */

type QbRepo = 'order' | 'tracking' | 'custody';

interface FakeQb {
  repo: QbRepo;
  alias: string;
  wheres: string[];
  selects: string[];
  groupBys: string[];
  joins: Array<{ entity: unknown; alias: string; condition: string }>;
  params: Record<string, unknown>;
  subs: Map<string, FakeQb>;
  terminal: 'getCount' | 'getRawOne' | 'getRawMany' | null;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  groupBy: jest.Mock;
  orderBy: jest.Mock;
  setParameter: jest.Mock;
  setParameters: jest.Mock;
  getQuery: jest.Mock;
  getCount: jest.Mock;
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
}

interface Resolver {
  count: (qb: FakeQb) => unknown;
  rawOne: (qb: FakeQb) => unknown;
  rawMany: (qb: FakeQb) => unknown;
}

const SUB_MARKER = /\(SUB:([a-z_]+)\)/g;
// TypeORM PostgresDriver.escapeQueryWithParameters bilan AYNAN bir xil naqsh.
const PARAM_PATTERN = /:(\.\.\.)?([A-Za-z0-9_.]+)/g;

const START = '2026-09-30T19:00:00.000Z';
const END = '2026-10-01T18:59:59.999Z';
const WEEK_START = '2026-09-27T19:00:00.000Z';

type DashboardInput = Parameters<
  OrderAnalyticsService['getBranchDashboardStats']
>[0];

const input = (overrides: Partial<DashboardInput> = {}): DashboardInput => ({
  branch_ids: ['16'],
  courier_ids: ['179'],
  start: START,
  end: END,
  today_start: START,
  week_start: WEEK_START,
  ...overrides,
});

const joinedWheres = (qb: FakeQb) => qb.wheres.join('\n');
const hasCurrentBatchFilter = (qb: FakeQb) =>
  qb.wheres.some((where) => where.includes('o.current_batch_id IS NOT NULL'));

const isSoldQb = (qb: FakeQb) =>
  qb.repo === 'order' && joinedWheres(qb).includes(':...soldStatuses');

function defaultCount(qb: FakeQb): number {
  const wheres = joinedWheres(qb);
  if (wheres.includes(':...soldStatuses')) return 6; // Sotilgan (sold_at)
  if (wheres.includes(':todayStart')) return 3;
  if (wheres.includes(':weekStart')) return 4;
  return 8; // Jami (tanlangan oyna)
}

function defaultRawOne(qb: FakeQb): unknown {
  if (qb.repo === 'tracking' && qb.alias === 't') return { count: '2' };
  const selects = qb.selects.join(' ');
  if (selects.includes('COUNT(DISTINCT o.current_batch_id)')) {
    return { count: '1' };
  }
  if (selects.includes('COUNT(DISTINCT o.courier_id)')) return { count: '2' };
  return { count: '0' };
}

function defaultRawMany(qb: FakeQb): unknown {
  if (qb.groupBys.includes('o.market_id')) {
    return [
      {
        market_id: '201',
        orders_count: '5',
        delivered_count: '3',
        total_price: '750000',
      },
    ];
  }
  if (qb.groupBys.includes('o.status') && hasCurrentBatchFilter(qb)) {
    return [{ status: 'on the road', count: '1' }];
  }
  if (qb.groupBys.includes('o.status')) {
    return [
      { status: 'new', count: '1' },
      { status: 'on the road', count: '2' },
      // Yaratilgan kun kogortasidagi sotilganlar — "Sotilgan" EMAS.
      { status: 'sold', count: '4' },
      { status: 'returned_to_market', count: '1' },
    ];
  }
  return [];
}

function createFakeQb(
  repo: QbRepo,
  alias: string,
  resolver: Resolver,
  lastQueried: Map<string, FakeQb>,
): FakeQb {
  const addParams = (params: unknown) => {
    if (params && typeof params === 'object') {
      Object.assign(qb.params, params);
    }
  };
  const addWhere = (condition: unknown, params?: unknown) => {
    if (typeof condition === 'string') {
      qb.wheres.push(condition);
      for (const match of condition.matchAll(SUB_MARKER)) {
        const sub = lastQueried.get(match[1]);
        if (sub) qb.subs.set(match[1], sub);
      }
    }
    addParams(params);
    return qb;
  };
  const addSelection = (selection: unknown) => {
    if (typeof selection === 'string') qb.selects.push(selection);
    return qb;
  };
  const addJoin = (
    entity: unknown,
    joinAlias: string,
    condition: string,
    params?: unknown,
  ) => {
    qb.joins.push({ entity, alias: joinAlias, condition });
    addParams(params);
    return qb;
  };
  const finish = (
    terminal: 'getCount' | 'getRawOne' | 'getRawMany',
    value: unknown,
  ) => {
    qb.terminal = terminal;
    return Promise.resolve(value);
  };

  const qb: FakeQb = {
    repo,
    alias,
    wheres: [],
    selects: [],
    groupBys: [],
    joins: [],
    params: {},
    subs: new Map(),
    terminal: null,
    select: jest.fn(addSelection),
    addSelect: jest.fn(addSelection),
    where: jest.fn(addWhere),
    andWhere: jest.fn(addWhere),
    innerJoin: jest.fn(addJoin),
    leftJoin: jest.fn(addJoin),
    groupBy: jest.fn((groupBy: string) => {
      qb.groupBys.push(groupBy);
      return qb;
    }),
    orderBy: jest.fn(() => qb),
    setParameter: jest.fn((key: string, value: unknown) => {
      qb.params[key] = value;
      return qb;
    }),
    setParameters: jest.fn((params: unknown) => {
      addParams(params);
      return qb;
    }),
    getQuery: jest.fn(() => {
      lastQueried.set(alias, qb);
      return `(SUB:${alias})`;
    }),
    getCount: jest.fn(() => finish('getCount', resolver.count(qb))),
    getRawOne: jest.fn(() => finish('getRawOne', resolver.rawOne(qb))),
    getRawMany: jest.fn(() => finish('getRawMany', resolver.rawMany(qb))),
  };
  return qb;
}

/** Ichki so'rov belgilarini o'sha QB ning shartlari bilan almashtiradi. */
function expandedSql(qb: FakeQb): string {
  const parts = [
    ...qb.selects,
    ...qb.joins.map((join) => join.condition),
    ...qb.wheres,
    ...qb.groupBys,
  ];
  return parts
    .join('\n')
    .replace(SUB_MARKER, (marker: string, alias: string) => {
      const sub = qb.subs.get(alias);
      return sub ? `(${expandedSql(sub)})` : marker;
    });
}

/**
 * Tashqi so'rov YAKUNIY SQL'idagi har bir parametr: (1) shu (tashqi) QB da
 * ro'yxatga olingan; (2) massiv bo'lsa — bo'sh emas (`IN ()` yo'q); (3)
 * skalyar bo'lsa — bir martadan ortiq ishlatilmagan (TypeORM takroriy
 * skalyarga bitta `$N` beradi; ikki xil enum ustunida Postgres uning turini
 * aniqlay olmaydi).
 */
function postgresParamProblems(qb: FakeQb): string[] {
  const problems: string[] = [];
  const scalarUses = new Map<string, number>();
  for (const match of expandedSql(qb).matchAll(PARAM_PATTERN)) {
    const spread = match[1] ?? '';
    const name = match[2];
    if (!Object.prototype.hasOwnProperty.call(qb.params, name)) {
      problems.push(`:${spread}${name} tashqi so'rovda ro'yxatga olinmagan`);
      continue;
    }
    const value = qb.params[name];
    if (spread) {
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`:...${name} bo'sh ro'yxat — IN ()`);
      }
    } else {
      scalarUses.set(name, (scalarUses.get(name) ?? 0) + 1);
    }
  }
  for (const [name, uses] of scalarUses) {
    if (uses > 1) problems.push(`:${name} skalyari ${uses} marta ishlatilgan`);
  }
  return problems;
}

const scopeOf = (qb: FakeQb) =>
  qb.wheres.find((where) => /o\.holder_(branch|courier)_id IN/.test(where)) ??
  '';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(
  options: {
    resolver?: Partial<Resolver>;
    identitySend?: jest.Mock;
  } = {},
) {
  const resolver: Resolver = {
    count: defaultCount,
    rawOne: defaultRawOne,
    rawMany: defaultRawMany,
    ...options.resolver,
  };
  const created: FakeQb[] = [];
  const lastQueried = new Map<string, FakeQb>();
  const makeRepo = (repo: QbRepo) => ({
    createQueryBuilder: jest.fn((alias: string) => {
      const qb = createFakeQb(repo, alias, resolver, lastQueried);
      created.push(qb);
      return qb;
    }),
  });
  const orderRepo = makeRepo('order');
  const trackingRepo = makeRepo('tracking');
  const custodyRepo = makeRepo('custody');
  const identityClient = {
    send:
      options.identitySend ??
      jest.fn(() =>
        of({
          success: true,
          data: [{ id: '201', name: 'Yandex', market_tg_token: 'secret' }],
        }),
      ),
  };
  const lookup = { getMarketsByIds: jest.fn().mockResolvedValue([]) };

  const service = new OrderAnalyticsService(
    orderRepo as never,
    trackingRepo as never,
    custodyRepo as never,
    identityClient as never,
    {} as never, // branchClient
    {} as never, // logisticsClient
    lookup as never, // lookup (OrderLookupService)
  );

  const orderQbs = () =>
    created.filter((qb) => qb.repo === 'order' && qb.alias === 'o');
  const findOrderQb = (predicate: (qb: FakeQb) => boolean) => {
    const matches = orderQbs().filter(predicate);
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const byAlias = (alias: string) => created.filter((qb) => qb.alias === alias);
  const trackingQb = () => {
    const matches = created.filter(
      (qb) => qb.repo === 'tracking' && qb.alias === 't',
    );
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const outerQbs = () => [
    ...orderQbs(),
    ...created.filter((qb) => qb.repo === 'tracking' && qb.alias === 't'),
  ];

  const cards = {
    sold: () => findOrderQb(isSoldQb),
    today: () => findOrderQb((qb) => joinedWheres(qb).includes(':todayStart')),
    week: () => findOrderQb((qb) => joinedWheres(qb).includes(':weekStart')),
    selected: () =>
      findOrderQb(
        (qb) =>
          qb.terminal === 'getCount' &&
          !isSoldQb(qb) &&
          !joinedWheres(qb).includes(':todayStart') &&
          !joinedWheres(qb).includes(':weekStart'),
      ),
    activeBatches: () =>
      findOrderQb(
        (qb) =>
          qb.selects.includes('COUNT(DISTINCT o.current_batch_id)') &&
          !qb.groupBys.length,
      ),
    statuses: () =>
      findOrderQb(
        (qb) => qb.groupBys.includes('o.status') && !hasCurrentBatchFilter(qb),
      ),
    markets: () => findOrderQb((qb) => qb.groupBys.includes('o.market_id')),
    packages: () =>
      findOrderQb(
        (qb) => qb.groupBys.includes('o.status') && hasCurrentBatchFilter(qb),
      ),
    activeCouriers: () =>
      findOrderQb((qb) => qb.selects.includes('COUNT(DISTINCT o.courier_id)')),
  };

  return {
    service,
    created,
    identityClient,
    lookup,
    orderQbs,
    outerQbs,
    byAlias,
    trackingQb,
    cards,
  };
}

describe('OrderAnalyticsService.getBranchDashboardStats (menejer statistikasi)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("javob shakli: eski maydonlar o'zgarmagan, cancelled va market_name qo'shilgan", async () => {
    const { service } = setup();

    const result = await service.getBranchDashboardStats(input());

    expect(result).toEqual({
      today_orders_count: 3,
      week_orders_count: 4,
      selected_orders_count: 8,
      active_batches_count: 1,
      orders_card: {
        total: 8,
        new: 1,
        on_the_road: 2,
        delivered: 6,
        returned: 1,
        cancelled: 2,
      },
      markets: [
        {
          market_id: '201',
          market_name: 'Yandex',
          orders_count: 5,
          delivered_count: 3,
          total_price: 750000,
        },
      ],
      packages: { on_the_way: 1, waiting_for_acceptance: 0 },
      active_couriers: 2,
    });
  });

  it("1) Sotilgan sold_at bo'yicha sanaladi, createdAt bo'yicha emas", async () => {
    const { service, cards } = setup();

    const result = await service.getBranchDashboardStats(input());

    const sold = cards.sold();
    expect(sold.andWhere).toHaveBeenCalledWith(
      'o.status IN (:...soldStatuses)',
      { soldStatuses: ['sold', 'paid', 'partly_paid'] },
    );
    expect(sold.andWhere).toHaveBeenCalledWith(
      'o.sold_at BETWEEN :soldStartMs AND :soldEndMs',
      {
        soldStartMs: String(Date.parse(START)),
        soldEndMs: String(Date.parse(END)),
      },
    );
    expect(sold.wheres.some((where) => where.includes('o.createdAt'))).toBe(
      false,
    );
    // statusRows dagi 'sold' (yaratilgan kun kogortasi) = 4 — ishlatilmaydi.
    expect(result.orders_card.delivered).toBe(6);
  });

  it('2) Sotilgan joriy doirada — saqlov tarixi qo`shilmaydi', async () => {
    const { service, cards } = setup();

    await service.getBranchDashboardStats(input());

    const scope = scopeOf(cards.sold());
    expect(scope).toContain('o.home_branch_id IN (:...branchIds)');
    expect(scope).not.toContain('EXISTS');
  });

  it('3) Bekor qilingan — bekor sanasi va bekor paytidagi egasi bo`yicha', async () => {
    const { service, trackingQb } = setup();

    const result = await service.getBranchDashboardStats(input());

    const t = trackingQb();
    expect(t.innerJoin).toHaveBeenCalledWith(Order, 'o', 'o.id = t.order_id');
    expect(t.selects).toEqual(['COUNT(DISTINCT t.order_id)']);
    expect(t.wheres).toEqual(
      expect.arrayContaining([
        'o.isDeleted = :isDeleted',
        't.to_status = :cancelledStatus',
        '(t.from_status IS NULL OR t.from_status NOT IN (:...cancelFamily))',
        'o.status IN (:...cancelFamily)',
        't.created_at BETWEEN :cancelStart AND :cancelEnd',
      ]),
    );
    expect(t.params).toMatchObject({
      isDeleted: false,
      cancelledStatus: 'cancelled',
      cancelFamily: ['cancelled', 'cancelled (sent)', 'closed'],
      cancelStart: new Date(START),
      cancelEnd: new Date(END),
      branchIds: ['16'],
      courierIds: ['179'],
    });

    const attribution = t.wheres.find((where) =>
      where.includes('EXISTS ((SUB:holder_at))'),
    );
    expect(attribution).toBeDefined();
    expect(attribution).toContain('t.changed_by IN (:...courierIds)');
    expect(attribution).toContain('o.home_branch_id IN (:...branchIds)');

    // Joriy ustunlar yo'q — tovar keyin HQ ga ketsa ham bekor "yo'qolmaydi".
    expect(expandedSql(t)).not.toMatch(
      /\bo\.(branch_id|holder_branch_id|courier_id|holder_courier_id)\b/,
    );
    expect(result.orders_card.cancelled).toBe(2);
  });

  it('4) saqlov ichki so`rovi bekor paytidagi (yoki undan oldingi) OXIRGI egani oladi', async () => {
    const { service, byAlias } = setup();

    await service.getBranchDashboardStats(input());

    const [holderAt] = byAlias('holder_at');
    expect(holderAt.repo).toBe('custody');
    expect(holderAt.wheres).toEqual([
      'holder_at.order_id = t.order_id',
      'holder_at.created_at <= t.created_at',
      '(holder_at.to_branch_id IN (:...branchIds) OR holder_at.to_courier_id IN (:...courierIds))',
      'NOT EXISTS ((SUB:holder_later))',
    ]);

    const [holderLater] = byAlias('holder_later');
    expect(holderLater.repo).toBe('custody');
    expect(holderLater.wheres).toEqual([
      'holder_later.order_id = holder_at.order_id',
      'holder_later.created_at > holder_at.created_at',
      'holder_later.created_at <= t.created_at',
    ]);
    // Ichki so'rovlar faqat satr sifatida qo'shiladi, alohida bajarilmaydi.
    expect(holderAt.terminal).toBeNull();
    expect(holderLater.terminal).toBeNull();
  });

  it('5) keyin ortga qaytarilgan bekor sanalmaydi', async () => {
    const { service, byAlias, trackingQb } = setup();

    await service.getBranchDashboardStats(input());

    const [undo] = byAlias('cancel_undo');
    expect(undo.repo).toBe('tracking');
    expect(undo.wheres).toEqual([
      'cancel_undo.order_id = t.order_id',
      'cancel_undo.created_at > t.created_at',
      'cancel_undo.to_status NOT IN (:...cancelFamily)',
    ]);
    expect(trackingQb().wheres).toContain('NOT EXISTS ((SUB:cancel_undo))');
  });

  it('6) Jami/bugun/hafta/market filialdan chiqib ketgan buyurtmani saqlab qoladi', async () => {
    const { service, cards, byAlias } = setup();

    const result = await service.getBranchDashboardStats(input());

    const selected = cards.selected();
    expect(selected.andWhere).toHaveBeenCalledWith(
      'o.createdAt BETWEEN :rangeStart AND :rangeEnd',
      { rangeStart: new Date(START), rangeEnd: new Date(END) },
    );
    for (const qb of [selected, cards.today(), cards.week(), cards.markets()]) {
      expect(scopeOf(qb)).toContain('EXISTS ((SUB:oce_hist))');
    }

    const histories = byAlias('oce_hist');
    expect(histories).toHaveLength(4);
    for (const history of histories) {
      expect(history.repo).toBe('custody');
      expect(history.wheres).toEqual([
        'oce_hist.order_id = o.id',
        '(oce_hist.from_branch_id IN (:...branchIds) OR oce_hist.to_branch_id IN (:...branchIds) OR oce_hist.from_courier_id IN (:...courierIds) OR oce_hist.to_courier_id IN (:...courierIds))',
      ]);
    }
    expect(result.orders_card.total).toBe(8);
    expect(result.today_orders_count).toBe(3);
    expect(result.week_orders_count).toBe(4);
  });

  it('7) "hozir qo`lda" kartalari (Yangi, Yo`lda, paketlar, faol kuryerlar) joriy doirada qoladi', async () => {
    const { service, cards } = setup();

    await service.getBranchDashboardStats(input());

    for (const qb of [
      cards.activeBatches(),
      cards.packages(),
      cards.statuses(),
      cards.activeCouriers(),
    ]) {
      expect(scopeOf(qb)).not.toBe('');
      expect(scopeOf(qb)).not.toContain('EXISTS');
    }
  });

  it("8) kuryer ro'yxati bo'sh — hech qayerda IN () yozilmaydi", async () => {
    const { service, created, byAlias } = setup();

    const result = await service.getBranchDashboardStats(
      input({ branch_ids: ['18'], courier_ids: [] }),
    );

    for (const qb of created) {
      for (const where of qb.wheres) {
        expect(where).not.toContain(':...courierIds');
        expect(where).not.toContain('t.changed_by');
      }
    }
    expect(byAlias('holder_at')[0].wheres).toContain(
      '(holder_at.to_branch_id IN (:...branchIds))',
    );
    expect(result.orders_card).toMatchObject({ delivered: 6, cancelled: 2 });
  });

  it("8b) filial ro'yxati bo'sh (faqat kuryerlar) — branchIds ham yozilmaydi", async () => {
    const { service, created, byAlias } = setup();

    await service.getBranchDashboardStats(
      input({ branch_ids: [], courier_ids: ['179'] }),
    );

    for (const qb of created) {
      for (const where of qb.wheres) {
        expect(where).not.toContain(':...branchIds');
        expect(where).not.toContain('o.home_branch_id');
      }
    }
    expect(byAlias('holder_at')[0].wheres).toContain(
      '(holder_at.to_courier_id IN (:...courierIds))',
    );
  });

  it('9) "Barchasi" (start yo`q) — hech bir so`rovda sana oralig`i yo`q', async () => {
    const { service, created } = setup();

    const result = await service.getBranchDashboardStats(
      input({ start: null }),
    );

    const allWheres = created.flatMap((qb) => qb.wheres).join('\n');
    expect(allWheres).not.toContain('o.sold_at BETWEEN');
    expect(allWheres).not.toContain('t.created_at BETWEEN');
    expect(allWheres).not.toContain('o.createdAt BETWEEN :rangeStart');
    expect(result.orders_card).toMatchObject({
      total: 8,
      delivered: 6,
      cancelled: 2,
    });
  });

  it('10) market kartasi identity dan faqat nomni oladi', async () => {
    const { service, identityClient, lookup } = setup();

    const result = await service.getBranchDashboardStats(input());

    expect(result.markets).toEqual([
      {
        market_id: '201',
        market_name: 'Yandex',
        orders_count: 5,
        delivered_count: 3,
        total_price: 750000,
      },
    ]);
    expect(result.markets[0]).not.toHaveProperty('market_tg_token');
    // attachRequestId: false — yuk aynan { ids }.
    expect(identityClient.send).toHaveBeenCalledTimes(1);
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.market.find_by_ids' },
      { ids: ['201'] },
    );
    // 5 s × 3 urinishli lookup ishlatilmaydi.
    expect(lookup.getMarketsByIds).not.toHaveBeenCalled();
  });

  it('11) identity ishlamasa — market_name null, qolgan kartalar joyida', async () => {
    const { service } = setup({
      identitySend: jest.fn(() => throwError(() => new Error('down'))),
    });

    const result = await service.getBranchDashboardStats(input());

    expect(result.markets).toHaveLength(1);
    expect(result.markets[0].market_name).toBeNull();
    expect(result.markets[0].orders_count).toBe(5);
    expect(result.orders_card).toMatchObject({
      total: 8,
      delivered: 6,
      cancelled: 2,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('12) bekor so`rovi yiqilsa — faqat cancelled 0, panel nolga tushmaydi', async () => {
    const { service } = setup({
      resolver: {
        rawOne: (qb) =>
          qb.repo === 'tracking'
            ? Promise.reject(new Error('relation does not exist'))
            : defaultRawOne(qb),
      },
    });

    const result = await service.getBranchDashboardStats(input());

    expect(result.orders_card.cancelled).toBe(0);
    expect(result.orders_card.delivered).toBe(6);
    expect(result.orders_card.total).toBe(8);
    expect(result.markets[0].market_name).toBe('Yandex');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('bekor qilinganlar hisobi olinmadi'),
    );
  });

  it.each([
    ['filial + kuryer', input()],
    ['faqat filial', input({ branch_ids: ['18'], courier_ids: [] })],
    ['faqat kuryer', input({ branch_ids: [], courier_ids: ['179'] })],
    ['Barchasi', input({ start: null })],
  ])(
    'Postgres qoidalari (%s): ichki so`rov parametrlari tashqi so`rovda, IN () yo`q, skalyar takrorlanmaydi',
    async (_label, payload) => {
      const { service, outerQbs, trackingQb } = setup();

      await service.getBranchDashboardStats(payload);

      const outer = outerQbs();
      // 10 ta tashqi so'rov: 8 ta eski + Sotilgan (o) + Bekor (t).
      expect(outer).toHaveLength(10);
      for (const qb of outer) {
        const problems = postgresParamProblems(qb);
        expect({ sql: expandedSql(qb), problems }).toEqual({
          sql: expandedSql(qb),
          problems: [],
        });
      }

      // Ichki so'rovlardagi parametrlar AYNAN tashqi `t` da ro'yxatda.
      const t = trackingQb();
      expect(t.params).toHaveProperty('cancelFamily');
      expect(expandedSql(t)).toContain(
        'cancel_undo.to_status NOT IN (:...cancelFamily)',
      );
    },
  );

  it('kechikish: sotilgan va bekor so`rovlari mavjud Promise.all bilan birga boshlanadi, nomlar esa market qatorlari kelishi bilan', async () => {
    const gates: Array<{ qb: FakeQb; open: () => void }> = [];
    const gated =
      (base: (qb: FakeQb) => unknown) =>
      (qb: FakeQb): Promise<unknown> =>
        new Promise((resolve) => {
          gates.push({ qb, open: () => resolve(base(qb)) });
        });
    const { service, identityClient } = setup({
      resolver: {
        count: gated(defaultCount),
        rawOne: gated(defaultRawOne),
        rawMany: gated(defaultRawMany),
      },
    });

    let settled = false;
    const pending = service.getBranchDashboardStats(input()).then((result) => {
      settled = true;
      return result;
    });
    await flush();

    // Ikkinchi ketma-ket to'plam yo'q: 10 ta so'rov bir vaqtda kutilmoqda.
    expect(gates).toHaveLength(10);
    expect(gates.some(({ qb }) => isSoldQb(qb))).toBe(true);
    expect(gates.some(({ qb }) => qb.repo === 'tracking')).toBe(true);
    expect(identityClient.send).not.toHaveBeenCalled();

    // Faqat market qatorlari keldi — nomlar so'rovi qolganlarni kutmaydi.
    gates.find(({ qb }) => qb.groupBys.includes('o.market_id'))?.open();
    await flush();
    expect(identityClient.send).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    for (const gate of gates) gate.open();
    const result = await pending;
    expect(result.orders_card).toMatchObject({ delivered: 6, cancelled: 2 });
    expect(result.markets[0].market_name).toBe('Yandex');
  });

  it('kechikish: market nomlari ko`pi bilan 1,5 s kutiladi va qayta urinilmaydi', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    let subscriptions = 0;
    const { service } = setup({
      // identity umuman javob bermaydi.
      identitySend: jest.fn(
        () =>
          new Observable<never>(() => {
            subscriptions += 1;
          }),
      ),
    });

    let settled = false;
    const pending = service.getBranchDashboardStats(input()).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1500);
    await flush();

    expect(settled).toBe(true);
    expect(subscriptions).toBe(1);
    const result = await pending;
    expect(result.markets[0].market_name).toBeNull();
    expect(result.orders_card.delivered).toBe(6);
  });

  it("market qatorlari bo'lmasa identity chaqirilmaydi", async () => {
    const { service, identityClient } = setup({
      resolver: {
        rawMany: (qb) =>
          qb.groupBys.includes('o.market_id') ? [] : defaultRawMany(qb),
      },
    });

    const result = await service.getBranchDashboardStats(input());

    expect(result.markets).toEqual([]);
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it("filial ham, kuryer ham bo'lmasa — so'rovsiz bo'sh javob (cancelled 0 bilan)", async () => {
    const { service, created, identityClient } = setup();

    const result = await service.getBranchDashboardStats(
      input({ branch_ids: [], courier_ids: [] }),
    );

    expect(created).toHaveLength(0);
    expect(identityClient.send).not.toHaveBeenCalled();
    expect(result.orders_card).toEqual({
      total: 0,
      new: 0,
      on_the_road: 0,
      delivered: 0,
      returned: 0,
      cancelled: 0,
    });
    expect(result.markets).toEqual([]);
  });
});
