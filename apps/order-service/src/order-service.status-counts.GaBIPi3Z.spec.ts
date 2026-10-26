import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * GaBIPi3Z — `order.status_counts`: holat tablari BITTA `GROUP BY status`
 * so'rovida, filtr qurilmasi `findAll` bilan AYNI (`buildOrderListQuery`),
 * qidiruv `findAllEnriched` bilan AYNI (`resolveListSearch`). «Bekor» tabi
 * alohida doirada bo'lsa — alohida COUNT; «Qabul va yaratish» badge'i —
 * `findNewMarkets` sharti (NEW + partiyasiz).
 */
type Qb = Record<string, jest.Mock>;

const andWhereSql = (qb: Qb) =>
  (qb.andWhere.mock.calls as unknown[][]).map((args) => String(args[0]));
const isBadge = (qb: Qb) =>
  andWhereSql(qb).includes('order.current_batch_id IS NULL');

/**
 * Har `createQueryBuilder` — yangi qurilma (vazifalar parallel, tartib
 * kafolatlanmaydi). Badge — `current_batch_id IS NULL` sharti borligidan.
 */
function setup(
  opts: {
    rows?: unknown[];
    tabCount?: number;
    badgeCount?: number;
    customerIds?: string[];
  } = {},
) {
  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  const qbs: Qb[] = [];
  const makeQb = () => {
    const qb: Qb = {};
    for (const name of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orWhere',
      'groupBy',
      'leftJoinAndSelect',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[name] = jest.fn(() => qb);
    }
    qb.clone = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(opts.rows ?? []);
    qb.getCount = jest.fn(() =>
      Promise.resolve(
        isBadge(qb) ? (opts.badgeCount ?? 0) : (opts.tabCount ?? 0),
      ),
    );
    qb.getMany = jest.fn().mockResolvedValue([]);
    qbs.push(qb);
    return qb;
  };
  const orderRepo = { createQueryBuilder: jest.fn(makeQb) };
  const identitySend = jest.fn(() =>
    of({ data: (opts.customerIds ?? []).map((id) => ({ id })) }),
  );
  Object.assign(service as object, {
    orderRepo,
    identityClient: { send: identitySend },
    logger: new Logger('spec'),
  });
  const grouped = () => qbs.filter((qb) => qb.groupBy.mock.calls.length);
  const badge = () => qbs.filter(isBadge);
  const tab = () =>
    qbs.filter((qb) => !qb.groupBy.mock.calls.length && !isBadge(qb));
  return { service, orderRepo, identitySend, qbs, grouped, badge, tab };
}

describe('GaBIPi3Z — OrderServiceService.statusCounts', () => {
  it('⭐ BITTA GROUP BY status (join yo`q), findAll bilan AYNI filtrlar; by_status + total', async () => {
    const { service, orderRepo, grouped } = setup({
      rows: [
        { status: 'new', count: '32' },
        { status: 'sold', count: '600' },
        { status: 'cancelled (sent)', count: '5' },
        { status: 'paid', count: '0' },
      ],
    });

    const res = await service.statusCounts({
      query: {
        market_id: '37',
        branch_id: '3',
        region_ids: ['5', '9'],
        where_deliver: 'center' as never,
        start_day: '2026-10-01',
        end_day: '2026-10-26',
        courier_ids: ['26'],
      },
    });

    expect(res).toEqual({
      by_status: { new: 32, sold: 600, 'cancelled (sent)': 5 },
      total: 637,
      cancelled: null,
      new_incoming: null,
      search_truncated: false,
    });
    expect(orderRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    const [qb] = grouped();
    expect(qb.select).toHaveBeenCalledWith('order.status', 'status');
    expect(qb.addSelect).toHaveBeenCalledWith('COUNT(*)', 'count');
    expect(qb.groupBy).toHaveBeenCalledWith('order.status');
    expect(qb.leftJoinAndSelect).not.toHaveBeenCalled();
    expect(qb.where).toHaveBeenCalledWith('order.isDeleted = :isDeleted', {
      isDeleted: false,
    });
    const sql = andWhereSql(qb);
    expect(sql).toContain('order.market_id = :market_id');
    expect(sql).toContain('order.region_id IN (:...scoped_region_ids)');
    expect(sql).toContain('order.where_deliver = :where_deliver');
    expect(sql).toContain('order.createdAt >= :startDate');
    expect(sql).toContain('order.createdAt <= :endDate');
    // Holat filtri berilmagan — barcha holatlar sanaladi.
    expect(sql).not.toContain('order.status IN (:...statuses)');
  });

  it('⭐ findAll ham xuddi shu filtr qurilmasidan (regressiya: market/branch/region_ids)', async () => {
    const { service, qbs } = setup();
    const query = {
      market_id: '37',
      branch_id: '3',
      region_ids: ['5'],
      district_id: '501',
    };
    await service.statusCounts({ query });
    await service.findAll({ ...query, page: 1, limit: 10 });
    const [counts, list] = qbs;
    expect(andWhereSql(counts).length).toBeGreaterThan(3);
    expect(andWhereSql(list)).toEqual(andWhereSql(counts));
  });

  it('qidiruv: «EL-…» → buyurtma id (mijoz qidiruvisiz); mos mijoz yo`q — nol, bazaga so`rov yo`q', async () => {
    const { service, identitySend, grouped } = setup({
      rows: [{ status: 'new', count: '1' }],
    });
    const res = await service.statusCounts({ query: { search: 'EL-100081' } });
    expect(res.total).toBe(1);
    expect(identitySend).not.toHaveBeenCalled();
    expect(grouped()).toHaveLength(1);

    const empty = setup({ customerIds: [] });
    const none = await empty.service.statusCounts({
      query: { search: 'Hech kim' },
    });
    expect(none).toMatchObject({ by_status: {}, total: 0 });
    expect(empty.orderRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('⭐ cancelled_query (filial inventari) — alohida COUNT o`sha doirada', async () => {
    const { service, tab: tabs } = setup({
      rows: [{ status: 'cancelled', count: '9' }],
      tabCount: 4,
    });
    const res = await service.statusCounts({
      query: { branch_id: '3' },
      cancelled_query: {
        branch_id: '3',
        status: ['cancelled'],
        holder_type: 'BRANCH' as never,
        canceled_post_unassigned: true,
      },
    });
    expect(res.cancelled).toBe(4);
    const [tab] = tabs();
    expect(tab.getCount).toHaveBeenCalledTimes(1);
    const sql = andWhereSql(tab);
    expect(sql).toContain('order.holder_type = :holder_type');
    expect(sql).toContain('order.canceled_post_id IS NULL');
    expect(sql).toContain('order.status IN (:...statuses)');
  });

  it('⭐ new_incoming: NEW + partiyasiz; filial — branch_id, SA/market — source != branch (+ market)', async () => {
    const { service, badge: badges } = setup({ badgeCount: 7 });
    const res = await service.statusCounts({
      query: {},
      new_incoming: { exclude_branch_source: true, market_id: '37' },
    });
    expect(res.new_incoming).toBe(7);
    const [badge] = badges();
    expect(badge.andWhere).toHaveBeenCalledWith('order.status = :status', {
      status: 'new',
    });
    const sql = andWhereSql(badge);
    expect(sql).toContain('order.current_batch_id IS NULL');
    expect(sql).toContain('order.source != :branch_source');
    expect(sql).toContain('order.market_id = :market_id');
    expect(sql).not.toContain('order.branch_id = :branch_id');

    const branch = setup({ badgeCount: 2 });
    await branch.service.statusCounts({
      query: { branch_id: '3' },
      new_incoming: { branch_id: '3' },
    });
    const [branchBadge] = branch.badge();
    expect(branchBadge.andWhere).toHaveBeenCalledWith(
      'order.branch_id = :branch_id',
      { branch_id: '3' },
    );
    expect(andWhereSql(branchBadge)).not.toContain(
      'order.source != :branch_source',
    );
  });
});
