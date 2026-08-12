import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import {
  BranchType,
  Order_status,
  Roles,
  Where_deliver,
  rmqSend,
} from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderLookupService } from '../lookup/order-lookup.service';

/**
 * Read-only order analytics / reporting service.
 *
 * Extracted from the 10k-line OrderServiceService god object (Audit:
 * "single-class god object with no domain layer"). Owns the dashboard/KPI,
 * top-N and revenue rollups — all read paths, no money mutation, so it can be
 * scaled/optimised independently of the money-critical lifecycle service.
 *
 * Shared cross-service resolvers (market/courier lookups) come from the injected
 * OrderLookupService — no longer duplicated here. getPostsByIds stays local as
 * it is an analytics-only logistics rollup.
 */
@Injectable()
export class OrderAnalyticsService {
  private readonly logger = new Logger(OrderAnalyticsService.name);

  /**
   * Upper bound on an analytics date span. These reports load individual order
   * rows for the range into memory and aggregate in JS (see getRevenueStats /
   * getMarketStat), so an uncapped user range (e.g. 2000..2030) would pull the
   * whole orders table — the platform's largest, ever-growing table — into the
   * process (latency cliff + memory pressure, amplified by rmqSend retries).
   * ~25 months comfortably covers year-over-year dashboards; wider requests are
   * clamped to the most recent window (and logged). Proper fix for arbitrarily
   * wide ranges is a SQL GROUP BY aggregation endpoint — tracked separately.
   */
  private static readonly MAX_ANALYTICS_SPAN_MS =
    768 * 24 * 60 * 60 * 1000;

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @InjectRepository(OrderCustodyEvent)
    private readonly orderCustodyEventRepo: Repository<OrderCustodyEvent>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    private readonly lookup: OrderLookupService,
  ) {}

  private analyticsDateRange(startDate?: string, endDate?: string) {
    const UZB_OFFSET_MS = 5 * 60 * 60 * 1000;

    const parseUzDate = (value: string, endOfDay: boolean): Date | null => {
      const parts = value.split('-').map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
        return null;
      }
      const [year, month, day] = parts;
      const utcMs = Date.UTC(
        year,
        month - 1,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
      return new Date(utcMs - UZB_OFFSET_MS);
    };

    const parseDateInput = (value: string, endOfDay: boolean) => {
      if (/^\d+$/.test(value)) {
        return new Date(Number(value));
      }
      if (value.includes('T')) {
        return new Date(value);
      }
      const parsedUz = parseUzDate(value, endOfDay);
      return parsedUz ?? new Date(value);
    };

    const hasStart = Boolean(startDate && String(startDate).trim().length > 0);
    const hasEnd = Boolean(endDate && String(endDate).trim().length > 0);

    let start: Date;
    let end: Date;

    if (!hasStart || !hasEnd) {
      const uzNow = new Date(Date.now() + UZB_OFFSET_MS);
      const year = uzNow.getUTCFullYear();
      const month = String(uzNow.getUTCMonth() + 1).padStart(2, '0');
      const day = String(uzNow.getUTCDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;
      start = parseUzDate(dateKey, false)!;
      end = parseUzDate(dateKey, true)!;
    } else {
      start = parseDateInput(String(startDate), false);
      end = parseDateInput(String(endDate), true);
    }

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new RpcException({
        statusCode: 400,
        message: 'Sana formati noto‘g‘ri',
      });
    }

    // Bound the span so a pathologically-wide range can't load the entire
    // orders table into memory (Audit: unbounded analytics query). Clamp the
    // start to the most-recent window rather than rejecting, so dashboards keep
    // working; log so the truncation is observable.
    const span = end.getTime() - start.getTime();
    if (span > OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS) {
      const clampedStart = new Date(
        end.getTime() - OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS,
      );
      this.logger.warn(
        `Analytics date span ${Math.round(span / 86_400_000)}d exceeds cap ` +
          `${Math.round(OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS / 86_400_000)}d; ` +
          `clamping start ${start.toISOString()} -> ${clampedStart.toISOString()}`,
      );
      start = clampedStart;
    }

    return { start, end };
  }

  private soldStatuses() {
    return [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID];
  }

  private cancelledMarketStatuses() {
    return [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
    ];
  }

  private activeMarketStatuses() {
    return [
      Order_status.CREATED,
      Order_status.NEW,
      Order_status.RECEIVED,
      Order_status.ON_THE_ROAD,
      Order_status.WAITING,
      Order_status.WAITING_CUSTOMER,
      Order_status.RETURNED_TO_MARKET,
    ];
  }

  private async countHistoricallyCancelledOrders(
    range: { start: Date; end: Date } | null,
    branchId?: string,
    courierId?: string,
    postIds: string[] = [],
  ) {
    const statuses = [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
    ];
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_branch_id = :analyticsBranchId OR oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    const parentCustodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('parent_oce')
      .select('1')
      .where('parent_oce.order_id = parent_o.id')
      .andWhere(
        '(parent_oce.from_branch_id = :analyticsBranchId OR parent_oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    const query = this.orderTrackingRepo
      .createQueryBuilder('t')
      .innerJoin(Order, 'o', 'o.id = t.order_id')
      .leftJoin(Order, 'parent_o', 'parent_o.id = o.parent_order_id')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('t.to_status IN (:...statuses)', { statuses })
      .andWhere('(t.action IS NULL OR t.action != :cancelledPostReceived)', {
        cancelledPostReceived: 'cancelled_post_received',
      })
      .select('COUNT(DISTINCT t.order_id)', 'count');

    if (branchId) {
      query.andWhere(
        `(
          o.branch_id = :analyticsBranchId
          OR o.holder_branch_id = :analyticsBranchId
          OR EXISTS (${custodySubQuery})
          OR parent_o.branch_id = :analyticsBranchId
          OR parent_o.holder_branch_id = :analyticsBranchId
          OR EXISTS (${parentCustodySubQuery})
        )`,
        { analyticsBranchId: branchId },
      );
    }

    if (branchId && !courierId) {
      query.andWhere('LOWER(t.changed_by_role) != :courierRole', {
        courierRole: Roles.COURIER,
      });
    }

    if (courierId) {
      const courierCustodySubQuery = this.orderCustodyEventRepo
        .createQueryBuilder('oce_courier')
        .select('1')
        .where('oce_courier.order_id = o.id')
        .andWhere(
          '(oce_courier.from_courier_id = :analyticsCourierId OR oce_courier.to_courier_id = :analyticsCourierId)',
        )
        .getQuery();
      const hasPostScope = postIds.length > 0;

      query.andWhere(
        `(
          o.courier_id = :analyticsCourierId
          OR o.holder_courier_id = :analyticsCourierId
          ${hasPostScope ? 'OR o.post_id IN (:...analyticsPostIds)' : ''}
          OR EXISTS (${courierCustodySubQuery})
        )`,
        {
          analyticsCourierId: courierId,
          ...(hasPostScope ? { analyticsPostIds: postIds } : {}),
        },
      );
    }

    if (range) {
      query.andWhere('t.created_at BETWEEN :start AND :end', range);
    }

    const row = await query.getRawOne<{ count?: string | number }>();
    return Number(row?.count ?? 0);
  }

  private async countBranchBatchAcceptedOrders(
    range: { start: Date; end: Date } | null,
    branchId?: string,
  ) {
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_branch_id = :analyticsBranchId OR oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    const query = this.orderTrackingRepo
      .createQueryBuilder('t')
      .innerJoin(Order, 'o', 'o.id = t.order_id')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('t.action = :action', { action: 'branch_batch_received' })
      .andWhere('t.to_status = :status', { status: Order_status.RECEIVED })
      .select('COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))', 'count');

    if (branchId) {
      query.andWhere(
        `(
          o.branch_id = :analyticsBranchId
          OR o.holder_branch_id = :analyticsBranchId
          OR EXISTS (${custodySubQuery})
        )`,
        { analyticsBranchId: branchId },
      );
    }

    if (range) {
      query.andWhere('t.created_at BETWEEN :start AND :end', range);
    }

    const row = await query.getRawOne<{ count?: string | number }>();
    return Number(row?.count ?? 0);
  }

  private applyAnalyticsBranchScope<
    T extends { andWhere: (...args: any[]) => T },
  >(query: T, branchId?: string): T {
    if (!branchId) {
      return query;
    }
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_branch_id = :analyticsBranchId OR oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    return query.andWhere(
      `(
        o.branch_id = :analyticsBranchId
        OR o.holder_branch_id = :analyticsBranchId
        OR EXISTS (${custodySubQuery})
      )`,
      { analyticsBranchId: branchId },
    );
  }

  private applyAnalyticsCourierScope<
    T extends { andWhere: (...args: any[]) => T },
  >(query: T, courierId: string, postIds: string[] = []): T {
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_courier_id = :analyticsCourierId OR oce.to_courier_id = :analyticsCourierId)',
      )
      .getQuery();
    const hasPostScope = postIds.length > 0;

    return query.andWhere(
      `(
        o.courier_id = :analyticsCourierId
        OR o.holder_courier_id = :analyticsCourierId
        ${hasPostScope ? 'OR o.post_id IN (:...analyticsPostIds)' : ''}
        OR EXISTS (${custodySubQuery})
      )`,
      {
        analyticsCourierId: courierId,
        ...(hasPostScope ? { analyticsPostIds: postIds } : {}),
      },
    );
  }

  private dateKey(date: Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private dateLabel(date: Date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
    })
      .format(date)
      .replace('/', '.')
      .replace('/', '.');
  }

  private normalizeRevenuePeriod(
    period?: string,
  ): 'daily' | 'weekly' | 'monthly' | 'yearly' {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (
      normalized === 'daily' ||
      normalized === 'weekly' ||
      normalized === 'monthly' ||
      normalized === 'yearly'
    ) {
      return normalized;
    }
    throw new RpcException({
      statusCode: 400,
      message: 'period must be one of: daily, weekly, monthly, yearly',
    });
  }

  private periodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    if (period === 'daily') return d;
    if (period === 'monthly') {
      d.setDate(1);
      return d;
    }
    if (period === 'yearly') {
      d.setMonth(0, 1);
      return d;
    }

    // weekly (week starts on Monday)
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diffToMonday);
    return d;
  }

  private nextPeriodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = new Date(date);
    if (period === 'daily') d.setDate(d.getDate() + 1);
    else if (period === 'weekly') d.setDate(d.getDate() + 7);
    else if (period === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  private periodKey(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateKey(d);
    }
    if (period === 'weekly') {
      return `W:${this.dateKey(d)}`;
    }
    if (period === 'monthly') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `M:${y}-${m}`;
    }
    return `Y:${d.getFullYear()}`;
  }

  private periodLabel(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateLabel(d);
    }
    if (period === 'weekly') {
      const end = new Date(d);
      end.setDate(end.getDate() + 6);
      return `${this.dateLabel(d)}-${this.dateLabel(end)}`;
    }
    if (period === 'monthly') {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${m}.${d.getFullYear()}`;
    }
    return String(d.getFullYear());
  }

  private async getPostsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{ id: string; courier_id?: string | null }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getAllPostsForAnalytics() {
    const limit = 100;
    let page = 1;
    let totalPages = 1;
    const rows: Array<{
      id: string;
      courier_id?: string | null;
      updatedAt?: string | Date | null;
    }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<{
        data?: {
          data?: Array<{
            id: string;
            courier_id?: string | null;
            updatedAt?: string | Date | null;
          }>;
          totalPages?: number;
        };
      }>(
        this.logisticsClient,
        { cmd: 'logistics.post.find_all' },
        { query: { page, limit } },
      ).catch(() => ({ data: { data: [], totalPages: 1 } }));

      rows.push(...(response?.data?.data ?? []));
      totalPages = Math.max(1, Number(response?.data?.totalPages ?? 1));
      page += 1;
    }

    return rows;
  }

  private async getBranchesByIds(ids: string[]) {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean)),
    );
    if (!uniqueIds.length) return [];

    const rows = await Promise.all(
      uniqueIds.map((id) =>
        rmqSend<{
          data?: {
            id?: string;
            name?: string | null;
            code?: string | null;
            type?: BranchType | string | null;
          };
        }>(
          this.branchClient,
          { cmd: 'branch.find_by_id' },
          { id, requester: { id: 'system', roles: [Roles.SUPERADMIN] } },
          { attachRequestId: false, retries: 1 },
        )
          .then((response) => response?.data ?? null)
          .catch(() => null),
      ),
    );

    return rows
      .filter(
        (
          row,
        ): row is {
          id?: string;
          name?: string | null;
          code?: string | null;
          type?: BranchType | string | null;
        } => Boolean(row?.id),
      )
      .map((row) => ({
        id: String(row.id),
        name: row.name ?? null,
        code: row.code ?? null,
        type: row.type ?? null,
      }));
  }

  private async getAllOperatorUsers() {
    const limit = 200;
    let page = 1;
    let totalPages = 1;
    const items: Array<{
      id?: string;
      name?: string;
      username?: string;
      market_id?: string;
    }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<any>(
        this.identityClient,
        { cmd: 'identity.user.find_all' },
        { query: { role: Roles.MARKET_OPERATOR, page, limit } },
      ).catch(() => null);

      const payload = response?.data ?? response ?? {};
      const batch = Array.isArray(payload?.items) ? payload.items : [];
      items.push(...batch);

      const pages = Number(payload?.meta?.totalPages ?? 1);
      totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
      page += 1;
      if (page > 100) break;
    }

    return items;
  }

  async getOverviewStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    all = false,
  ) {
    const range = all ? null : this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();

    const soldOrdersQuery = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      branchId,
    ).select([
      'o.id',
      'o.market_id',
      'o.post_id',
      'o.where_deliver',
      'o.total_price',
    ]);

    if (range) {
      const startMs = String(range.start.getTime());
      const endMs = String(range.end.getTime());
      soldOrdersQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs,
        endMs,
      });
    }

    const [acceptedCount, cancelled, soldOrders] = await Promise.all([
      this.countBranchBatchAcceptedOrders(range, branchId),
      this.countHistoricallyCancelledOrders(range, branchId),
      soldOrdersQuery.getMany(),
    ]);
    const soldAndPaid = soldOrders.length;

    const marketIds = [
      ...new Set(soldOrders.map((o) => o.market_id).filter(Boolean)),
    ];
    const postIds = [
      ...new Set(soldOrders.map((o) => o.post_id).filter(Boolean) as string[]),
    ];
    const [markets, posts] = await Promise.all([
      this.lookup.getMarketsByIds(marketIds),
      this.getPostsByIds(postIds),
    ]);
    const courierIds = [
      ...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[]),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);

    const marketMap = new Map(markets.map((m) => [String(m.id), m]));
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    let profit = 0;
    let totalRevenue = 0;
    for (const order of soldOrders) {
      totalRevenue += Number(order.total_price ?? 0);
      const market = marketMap.get(String(order.market_id));
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      const courier = courierId ? courierMap.get(String(courierId)) : null;
      if (order.where_deliver === Where_deliver.ADDRESS) {
        profit +=
          Number(market?.tariff_home ?? 0) - Number(courier?.tariff_home ?? 0);
      } else {
        profit +=
          Number(market?.tariff_center ?? 0) -
          Number(courier?.tariff_center ?? 0);
      }
    }

    return {
      acceptedCount,
      total: acceptedCount,
      totalOrders: acceptedCount,
      ordersCount: acceptedCount,
      cancelled,
      soldAndPaid,
      profit,
      totalRevenue,
      from: range?.start.getTime(),
      to: range?.end.getTime(),
    };
  }

  async getMarketStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const totalsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'total')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; total: string }>();

    const soldsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'sold')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; sold: string }>();

    const totalsMap = new Map(
      totalsRaw.map((r) => [String(r.market_id), Number(r.total)]),
    );
    const soldsMap = new Map(
      soldsRaw.map((r) => [String(r.market_id), Number(r.sold)]),
    );
    const marketIds = Array.from(
      new Set([...totalsMap.keys(), ...soldsMap.keys()]),
    );
    const markets = await this.lookup.getMarketsByIds(marketIds);

    const result = markets.map((market) => {
      const totalOrders = totalsMap.get(String(market.id)) ?? 0;
      const soldOrders = soldsMap.get(String(market.id)) ?? 0;
      const sellingRate =
        totalOrders > 0
          ? Number(((soldOrders * 100) / totalOrders).toFixed(2))
          : 0;
      return { market, totalOrders, soldOrders, sellingRate };
    });

    result.sort((a, b) => b.sellingRate - a.sellingRate);
    return result;
  }

  async getCourierStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = start.getTime();
    const endMs = end.getTime();
    const postRows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.post_id', 'post_id')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
          {
            start,
            end,
          },
        )
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.post_id')
      .getRawMany<{ post_id: string }>();
    const postIds = postRows.map((row) => String(row.post_id)).filter(Boolean);

    if (!postIds.length) {
      return [];
    }

    const posts = await this.getPostsByIds(postIds);

    const orders = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', {
          postIds,
        })
        .andWhere(
          'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
          {
            start,
            end,
          },
        ),
      branchId,
    )
      .select(['o.id', 'o.status', 'o.post_id', 'o.sold_at'])
      .getMany();

    const postMap = new Map<string, { id: string; courier_id?: string | null }>(
      posts.map((post) => [String(post.id), post]),
    );
    const courierIds = [
      ...new Set(
        posts.map((post) => post.courier_id).filter(Boolean) as string[],
      ),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);

    const statsByCourier = new Map<string, { total: number; sold: number }>();
    for (const order of orders) {
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      if (!courierId) continue;
      const current = statsByCourier.get(String(courierId)) ?? {
        total: 0,
        sold: 0,
      };
      current.total += 1;
      const soldAt = order.sold_at ? Number(order.sold_at) : null;
      if (
        soldStatuses.includes(order.status) &&
        soldAt &&
        soldAt >= startMs &&
        soldAt <= endMs
      ) {
        current.sold += 1;
      }
      statsByCourier.set(String(courierId), current);
    }

    const result = couriers.map((courier) => {
      const stats = statsByCourier.get(String(courier.id)) ?? {
        total: 0,
        sold: 0,
      };
      const successRate =
        stats.total > 0
          ? Number(((stats.sold * 100) / stats.total).toFixed(2))
          : 0;
      return {
        courier,
        totalOrders: stats.total,
        soldOrders: stats.sold,
        successRate,
      };
    });

    result.sort((a, b) => b.successRate - a.successRate);
    return result;
  }

  async getTopMarkets(
    limit = 10,
    branchId?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = startDate ? new Date(startDate) : lastMonth;
    const toDate = endDate ? new Date(endDate) : undefined;

    const totalsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'total_orders')
        .addSelect(
          `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
          'successful_orders',
        )
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :fromDate', { fromDate })
        .andWhere(toDate ? 'o.createdAt <= :toDate' : '1=1', { toDate })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .setParameter('statuses', soldStatuses)
      .groupBy('o.market_id')
      .getRawMany<{
        market_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    const markets = await this.lookup.getMarketsByIds(
      totalsRaw.map((r) => String(r.market_id)),
    );
    const marketMap = new Map(markets.map((m) => [String(m.id), m]));

    const result = totalsRaw
      .filter((row) => Number(row.total_orders) >= 30)
      .map((row) => {
        const totalOrders = Number(row.total_orders);
        const successfulOrders = Number(row.successful_orders);
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const market = marketMap.get(String(row.market_id));
        return {
          market_id: row.market_id,
          market_name: market?.name ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);

    return result;
  }

  async getTopCouriers(limit = 10, branchId?: string) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const orders = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :lastMonth', { lastMonth })
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .select(['o.post_id', 'o.status'])
      .getMany();

    const posts = await this.getPostsByIds([
      ...new Set(orders.map((o) => o.post_id).filter(Boolean) as string[]),
    ]);
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierIds = [
      ...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[]),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    const stats = new Map<string, { total: number; successful: number }>();
    for (const order of orders) {
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      if (!courierId) continue;
      const current = stats.get(String(courierId)) ?? {
        total: 0,
        successful: 0,
      };
      current.total += 1;
      if (soldStatuses.includes(order.status)) {
        current.successful += 1;
      }
      stats.set(String(courierId), current);
    }

    return Array.from(stats.entries())
      .map(([courierId, current]) => {
        const courier = courierMap.get(courierId);
        const successRate =
          current.total > 0
            ? Number(((current.successful * 100) / current.total).toFixed(2))
            : 0;
        return {
          courier_id: courierId,
          courier_name: courier?.name ?? null,
          total_orders: current.total,
          successful_orders: current.successful,
          success_rate: successRate,
        };
      })
      .filter((row) => row.total_orders >= 30)
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getTopBranches(
    limit = 10,
    branchId?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = startDate ? new Date(startDate) : lastMonth;
    const toDate = endDate ? new Date(endDate) : undefined;

    const branchExpression =
      'COALESCE(o.home_branch_id, o.branch_id, o.holder_branch_id)';
    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select(branchExpression, 'branch_id')
        .addSelect('COUNT(*)', 'total_orders')
        .addSelect(
          `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
          'successful_orders',
        )
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :fromDate', { fromDate })
        .andWhere(toDate ? 'o.createdAt <= :toDate' : '1=1', { toDate })
        .andWhere(
          '(o.home_branch_id IS NOT NULL OR o.branch_id IS NOT NULL OR o.holder_branch_id IS NOT NULL)',
        ),
      branchId,
    )
      .setParameter('statuses', soldStatuses)
      .groupBy(branchExpression)
      .getRawMany<{
        branch_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    const branches = await this.getBranchesByIds(
      rows.map((row) => String(row.branch_id)),
    );
    const branchMap = new Map(
      branches.map((branch) => [String(branch.id), branch]),
    );

    return rows
      .filter((row) => {
        const branch = branchMap.get(String(row.branch_id));
        return Number(row.total_orders) >= 30 && branch?.type !== BranchType.HQ;
      })
      .map((row) => {
        const totalOrders = Number(row.total_orders) || 0;
        const successfulOrders = Number(row.successful_orders) || 0;
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const branch = branchMap.get(String(row.branch_id));
        const branchName = branch?.code
          ? `${branch.name ?? `Filial ${row.branch_id}`} (${branch.code})`
          : branch?.name;

        return {
          branch_id: String(row.branch_id),
          branch_name: branchName ?? `Filial ${row.branch_id}`,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getTopOperatorsByMarket(marketId: string, limit = 10) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.operator_id', 'operator_id')
      .addSelect('COUNT(*)', 'total_orders')
      .addSelect(
        `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
        'successful_orders',
      )
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.market_id = :marketId', { marketId })
      .andWhere('o.createdAt >= :lastMonth', { lastMonth })
      .andWhere('o.operator_id IS NOT NULL')
      .setParameter('statuses', soldStatuses)
      .groupBy('o.operator_id')
      .getRawMany<{
        operator_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    if (!rows.length) {
      return [];
    }

    const operators = await this.getAllOperatorUsers();
    const byId = new Map<string, any>();

    for (const operator of operators) {
      if (marketId && String(operator?.market_id ?? '') !== String(marketId)) {
        continue;
      }
      const idKey = String(operator?.id ?? '').trim();
      if (idKey) byId.set(idKey, operator);
    }

    return rows
      .map((row) => {
        const totalOrders = Number(row.total_orders) || 0;
        const successfulOrders = Number(row.successful_orders) || 0;
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const operatorId = String(row.operator_id ?? '').trim();
        const matched = byId.get(operatorId) ?? null;

        return {
          operator_id: operatorId || null,
          operator_name: matched?.name ?? matched?.username ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getCourierStat(
    courierId: string,
    startDate?: string,
    endDate?: string,
    all = false,
  ) {
    const range = all ? null : this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const courierPosts = (await this.getAllPostsForAnalytics()).filter(
      (post) => {
        return String(post.courier_id) === String(courierId);
      },
    );

    const postIds = courierPosts.map((post) => post.id);
    const totalOrdersQuery = this.applyAnalyticsCourierScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false }),
      courierId,
      postIds,
    );
    const soldOrdersQuery = this.applyAnalyticsCourierScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      courierId,
      postIds,
    );

    if (range) {
      const startMs = String(range.start.getTime());
      const endMs = String(range.end.getTime());
      totalOrdersQuery.andWhere(
        'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
        range,
      );
      soldOrdersQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs,
        endMs,
      });
    }

    const [totalOrders, canceledOrders, soldOrderEntities] = await Promise.all([
      totalOrdersQuery.getCount(),
      this.countHistoricallyCancelledOrders(
        range,
        undefined,
        courierId,
        postIds,
      ),
      soldOrdersQuery.getMany(),
    ]);
    const soldOrders = soldOrderEntities.length;

    const couriers = await this.lookup.getCouriersByIds([courierId]);
    const courier = couriers[0];

    let profit = 0;
    for (const order of soldOrderEntities) {
      profit +=
        order.where_deliver === Where_deliver.ADDRESS
          ? Number(courier?.tariff_home ?? 0)
          : Number(courier?.tariff_center ?? 0);
    }

    const successRate =
      totalOrders > 0
        ? Number(((soldOrders * 100) / totalOrders).toFixed(2))
        : 0;

    return {
      totalOrders,
      soldOrders,
      canceledOrders,
      profit,
      successRate,
    };
  }

  async getMarketStat(marketId: string, startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const allOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
      .andWhere('o.market_id = :marketId', { marketId })
      .getMany();

    if (!allOrders.length) {
      return {
        totalOrders: 0,
        soldOrders: 0,
        canceledOrders: 0,
        inProgress: 0,
        profit: 0,
        successRate: 0,
      };
    }

    const orderIds = allOrders.map((order) => order.id);

    const activeStatuses = this.activeMarketStatuses();
    const cancelledStatuses = this.cancelledMarketStatuses();
    const [soldOrders, canceledOrders, inProgress, soldOrderEntities] =
      await Promise.all([
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
          .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
          .andWhere('o.status IN (:...statuses)', {
            statuses: cancelledStatuses,
          })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.status IN (:...statuses)', { statuses: activeStatuses })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
          .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
          .getMany(),
      ]);

    const profit = soldOrderEntities.reduce(
      (sum, order) => sum + Number(order.to_be_paid ?? 0),
      0,
    );
    const successRate =
      allOrders.length > 0
        ? Number(((soldOrders * 100) / allOrders.length).toFixed(2))
        : 0;

    return {
      totalOrders: allOrders.length,
      soldOrders,
      canceledOrders,
      inProgress,
      profit,
      successRate,
    };
  }

  async getRevenueStats(
    startDate?: string,
    endDate?: string,
    period = 'daily',
  ) {
    const normalizedPeriod = this.normalizeRevenuePeriod(period);
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const soldOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
      .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
      .select(['o.id', 'o.total_price', 'o.sold_at'])
      .getMany();

    const buckets = new Map<
      string,
      { period: string; label: string; ordersCount: number; revenue: number }
    >();
    let cursor = this.periodStart(start, normalizedPeriod);
    const endCursor = this.periodStart(end, normalizedPeriod);

    while (cursor <= endCursor) {
      const key = this.periodKey(cursor, normalizedPeriod);
      buckets.set(key, {
        period: key,
        label: this.periodLabel(cursor, normalizedPeriod),
        ordersCount: 0,
        revenue: 0,
      });
      cursor = this.nextPeriodStart(cursor, normalizedPeriod);
    }

    for (const order of soldOrders) {
      if (!order.sold_at) continue;
      const soldDate = new Date(Number(order.sold_at));
      const key = this.periodKey(soldDate, normalizedPeriod);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.ordersCount += 1;
      bucket.revenue += Number(order.total_price ?? 0);
    }

    const data = Array.from(buckets.values());
    const totalRevenue = data.reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = data.reduce((sum, row) => sum + row.ordersCount, 0);
    const avgRevenue = data.length ? Math.round(totalRevenue / data.length) : 0;

    return {
      data,
      summary: {
        totalRevenue,
        totalOrders,
        avgRevenue,
      },
    };
  }
}
