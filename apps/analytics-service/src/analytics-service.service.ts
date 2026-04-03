import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Order_status, Roles, rmqSend } from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';

interface RequesterContext {
  id: string;
  roles?: string[];
}

interface RevenueFilter {
  startDate?: string;
  endDate?: string;
  fromDate?: string;
  toDate?: string;
  period?: string;
  page?: number;
  limit?: number;
}

type RevenuePeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Injectable()
export class AnalyticsServiceService {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private unwrap<T>(response: T | { data?: T }) {
    if (
      response &&
      typeof response === 'object' &&
      'data' in response
    ) {
      return (response as { data?: T }).data ?? response;
    }
    return response;
  }

  private normalizeDateRange(filter: { startDate?: string; endDate?: string }) {
    const { startDate, endDate } = filter;

    if (!startDate || !endDate) {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      };
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (!startDate.includes('T')) {
      start.setHours(0, 0, 0, 0);
    }
    if (!endDate.includes('T')) {
      end.setHours(23, 59, 59, 999);
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  private normalizeDateRangeAny(filter: RevenueFilter = {}) {
    return this.normalizeDateRange({
      startDate: filter.startDate ?? filter.fromDate,
      endDate: filter.endDate ?? filter.toDate,
    });
  }

  private normalizePagination(filter: { page?: number; limit?: number } = {}) {
    const page = Number(filter.page ?? 1);
    const limit = Number(filter.limit ?? 20);
    return {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    };
  }

  private roleSet(requester?: RequesterContext) {
    return new Set((requester?.roles ?? []).map((role) => String(role).toLowerCase()));
  }

  private normalizeRevenuePeriod(period?: string): RevenuePeriod {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly' || normalized === 'yearly') {
      return normalized;
    }
    return 'daily';
  }

  private parseNumber(value: unknown, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  private parseDateValue(value?: string | number | Date | null) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private isInRange(date: Date | null, start: Date, end: Date) {
    if (!date) return false;
    const ms = date.getTime();
    return ms >= start.getTime() && ms <= end.getTime();
  }

  private async requestOrderPage(query: Record<string, any>) {
    const response = await rmqSend<any>(this.orderClient, { cmd: 'order.find_all' }, { query });
    if (response && typeof response === 'object' && Array.isArray(response.data)) {
      return {
        data: response.data as any[],
        total: this.parseNumber(response.total, 0),
        page: this.parseNumber(response.page, query.page ?? 1),
        limit: this.parseNumber(response.limit, query.limit ?? 20),
      };
    }

    const wrapped = this.unwrap<any>(response as any) as any;
    if (wrapped && typeof wrapped === 'object' && Array.isArray(wrapped.data)) {
      return {
        data: wrapped.data as any[],
        total: this.parseNumber(wrapped.total, 0),
        page: this.parseNumber(wrapped.page, query.page ?? 1),
        limit: this.parseNumber(wrapped.limit, query.limit ?? 20),
      };
    }

    return {
      data: [],
      total: 0,
      page: this.parseNumber(query.page, 1),
      limit: this.parseNumber(query.limit, 20),
    };
  }

  private async collectOrders(query: Record<string, any>) {
    const limit = 200;
    let page = 1;
    let total = 0;
    const items: any[] = [];

    while (true) {
      const res = await this.requestOrderPage({ ...query, page, limit });
      total = res.total;
      items.push(...res.data);
      if (items.length >= total || res.data.length === 0) break;
      page += 1;
      if (page > 100) break;
    }

    return { items, total };
  }

  private async countOrdersByStatus(
    status: Order_status,
    range: { startDate: string; endDate: string },
  ) {
    const response = await this.requestOrderPage({
      status,
      start_day: range.startDate,
      end_day: range.endDate,
      page: 1,
      limit: 1,
    });
    return response.total;
  }

  private normalizePagedResponse(response: any): { items: any[]; total: number; totalPages: number } {
    const direct = this.unwrap<any>(response as any) as any;
    const root = direct && typeof direct === 'object' ? direct : {};
    const items = Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.data?.items)
        ? root.data.items
        : [];
    const meta = root.meta ?? root.pagination ?? root.data?.meta ?? root.data?.pagination ?? {};
    const total = this.parseNumber(meta.total, items.length);
    const totalPages = this.parseNumber(meta.totalPages, Math.max(1, Math.ceil(total / Math.max(1, items.length || 1))));
    return { items, total, totalPages };
  }

  private async collectIdentityUsers(cmd: string, query: Record<string, any> = {}) {
    const limit = 200;
    let page = 1;
    let totalPages = 1;
    const items: any[] = [];

    while (page <= totalPages) {
      const response = await rmqSend<any>(this.identityClient, { cmd }, { query: { ...query, page, limit } });
      const normalized = this.normalizePagedResponse(response);
      items.push(...normalized.items);
      totalPages = normalized.totalPages;
      page += 1;
      if (page > 100) break;
    }

    return items;
  }

  async getDashboard(
    requester: RequesterContext | undefined,
    filter: { startDate?: string; endDate?: string },
  ) {
    const normalized = this.normalizeDateRange(filter);
    const roles = this.roleSet(requester);

    if (roles.has(Roles.COURIER)) {
      const [myStat, couriers, topCouriers] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stat' },
          { requester, ...normalized },
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stats' },
          normalized,
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_couriers' },
          {},
        ),
      ]);

      return successRes(
        {
          myStat: this.unwrap(myStat),
          couriers: this.unwrap(couriers),
          topCouriers: this.unwrap(topCouriers),
        },
        200,
        'Dashboard infos',
      );
    }

    if (roles.has(Roles.MARKET)) {
      const [myStat, markets, topMarkets] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stat' },
          { requester, ...normalized },
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stats' },
          normalized,
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_markets' },
          {},
        ),
      ]);

      return successRes(
        {
          myStat: this.unwrap(myStat),
          markets: this.unwrap(markets),
          topMarkets: this.unwrap(topMarkets),
        },
        200,
        'Dashboard infos',
      );
    }

    const [orders, markets, couriers, topMarkets, topCouriers, financialBalance, activeCouriersCount, allAdminUsers, allMarketsUsers] = await Promise.all([
      rmqSend(this.orderClient, { cmd: 'order.analytics.overview' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.market_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.courier_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_markets' }, {}),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_couriers' }, {}),
      rmqSend(this.financeClient, { cmd: 'finance.cashbox.financial_balance' }, {}).catch(() => null),
      rmqSend(this.identityClient, { cmd: 'identity.courier.find_all' }, { query: { status: 'active', page: 1, limit: 1 } }).catch(() => null),
      this.collectIdentityUsers('identity.user.find_all').catch(() => []),
      this.collectIdentityUsers('identity.market.find_all').catch(() => []),
    ]);

    const start = new Date(normalized.startDate);
    const end = new Date(normalized.endDate);
    const newUsersCount = [...allAdminUsers, ...allMarketsUsers]
      .filter((user) => this.isInRange(this.parseDateValue(user?.createdAt), start, end))
      .length;
    const activeCouriers = this.normalizePagedResponse(activeCouriersCount).total;

    return successRes(
      {
        orders: this.unwrap(orders),
        markets: this.unwrap(markets),
        couriers: this.unwrap(couriers),
        topMarkets: this.unwrap(topMarkets),
        topCouriers: this.unwrap(topCouriers),
        financialBalance: this.unwrap(financialBalance as any),
        newUsersCount,
        activeCouriers,
      },
      200,
      'Dashboard infos',
    );
  }

  async getRevenueStats(
    _requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRangeAny(filter);
    const period = this.normalizeRevenuePeriod(filter.period);

    const [revenue, financialBalance] = await Promise.all([
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.revenue' },
        { ...normalized, period },
      ),
      rmqSend(this.financeClient, { cmd: 'finance.cashbox.financial_balance' }, {}).catch(() => null),
    ]);

    const revenueData = this.unwrap<any>(revenue as any) as any;
    const labels = Array.isArray(revenueData?.data) ? revenueData.data.map((row: any) => row.label ?? row.period) : [];
    const values = Array.isArray(revenueData?.data) ? revenueData.data.map((row: any) => this.parseNumber(row.revenue)) : [];

    return successRes(
      {
        ...(revenueData ?? {}),
        chart: { labels, values },
        finance: this.unwrap(financialBalance as any),
      },
      200,
      `Revenue stats (${period})`,
    );
  }

  async getKpiStats(
    _requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRangeAny(filter);
    const [overview, revenue, courierStats, topMarkets] = await Promise.all([
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.overview' },
        normalized,
      ),
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.revenue' },
        { ...normalized, period: 'daily' },
      ),
      rmqSend(this.orderClient, { cmd: 'order.analytics.courier_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_markets' }, { limit: 10 }),
    ]);

    const soldStatuses = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.CLOSED,
      Order_status.PARTLY_PAID,
    ];

    const soldOrdersResult = await Promise.all(
      soldStatuses.map((status) =>
        this.collectOrders({
          status,
          start_day: normalized.startDate,
          end_day: normalized.endDate,
        }),
      ),
    );
    const soldOrders = soldOrdersResult.flatMap((res) => res.items);

    let deliveryMsTotal = 0;
    let deliveryCount = 0;
    for (const order of soldOrders) {
      const createdAt = this.parseDateValue(order?.createdAt);
      const soldAt = order?.sold_at ? new Date(Number(order.sold_at)) : null;
      if (!createdAt || !soldAt || Number.isNaN(soldAt.getTime())) continue;
      const diff = soldAt.getTime() - createdAt.getTime();
      if (diff > 0) {
        deliveryMsTotal += diff;
        deliveryCount += 1;
      }
    }

    const overviewData = this.unwrap<any>(overview as any) as any;
    const revenueData = this.unwrap<any>(revenue as any) as any;
    const courierStatsData = Array.isArray(this.unwrap<any>(courierStats as any))
      ? (this.unwrap<any>(courierStats as any) as any[])
      : [];
    const topMarketsData = Array.isArray(this.unwrap<any>(topMarkets as any))
      ? (this.unwrap<any>(topMarkets as any) as any[])
      : [];

    const totalOrders = this.parseNumber(overviewData?.acceptedCount);
    const soldAndPaid = this.parseNumber(overviewData?.soldAndPaid);
    const cancelled = this.parseNumber(overviewData?.cancelled);
    const totalRevenue = this.parseNumber(revenueData?.summary?.totalRevenue);
    const avgOrderValue = soldAndPaid > 0 ? Number((totalRevenue / soldAndPaid).toFixed(2)) : 0;
    const fulfillmentHours = deliveryCount > 0 ? Number(((deliveryMsTotal / deliveryCount) / (1000 * 60 * 60)).toFixed(2)) : 0;
    const cancellationRate = totalOrders > 0 ? Number(((cancelled * 100) / totalOrders).toFixed(2)) : 0;
    const courierEfficiency = courierStatsData.length > 0
      ? Number((courierStatsData.reduce((sum, row) => sum + this.parseNumber(row.totalOrders), 0) / courierStatsData.length).toFixed(2))
      : 0;

    return successRes(
      {
        averageOrderValue: avgOrderValue,
        averageFulfillmentHours: fulfillmentHours,
        cancellationRate,
        courierEfficiency,
        marketRating: topMarketsData,
      },
      200,
      'KPI stats',
    );
  }

  async getOrderReport(
    _requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRangeAny(filter);
    const [overview, topMarkets] = await Promise.all([
      rmqSend(this.orderClient, { cmd: 'order.analytics.overview' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_markets' }, { limit: 10 }),
    ]);

    const statuses: Order_status[] = [
      Order_status.NEW,
      Order_status.RECEIVED,
      Order_status.ON_THE_ROAD,
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
    ];

    const counts = await Promise.all(
      statuses.map((status) => this.countOrdersByStatus(status, normalized)),
    );
    const statusDistribution = statuses.reduce<Record<string, number>>((acc, status, index) => {
      acc[status] = counts[index];
      return acc;
    }, {});

    const allOrders = await this.collectOrders({
      start_day: normalized.startDate,
      end_day: normalized.endDate,
    });

    const regionMap = new Map<string, number>();
    const productMap = new Map<string, { product_id: string; total_quantity: number }>();
    for (const order of allOrders.items) {
      const regionId = String(order?.region_id ?? 'unknown');
      regionMap.set(regionId, (regionMap.get(regionId) ?? 0) + 1);

      const items = Array.isArray(order?.items) ? order.items : [];
      for (const item of items) {
        const productId = String(item?.product_id ?? 'unknown');
        const quantity = this.parseNumber(item?.quantity, 1);
        const current = productMap.get(productId) ?? { product_id: productId, total_quantity: 0 };
        current.total_quantity += quantity;
        productMap.set(productId, current);
      }
    }

    const byRegion = Array.from(regionMap.entries())
      .map(([region_id, total_orders]) => ({ region_id, total_orders }))
      .sort((a, b) => b.total_orders - a.total_orders);
    const topProducts = Array.from(productMap.values())
      .sort((a, b) => b.total_quantity - a.total_quantity)
      .slice(0, 10);

    return successRes(
      {
        range: normalized,
        overview: this.unwrap(overview as any),
        statusDistribution,
        byRegion,
        topMarkets: this.unwrap(topMarkets as any),
        topProducts,
      },
      200,
      'Order report',
    );
  }

  async getFinanceReport(
    _requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRangeAny(filter);
    const pagination = this.normalizePagination(filter);
    const [allInfo, balance] = await Promise.all([
      rmqSend(this.financeClient, { cmd: 'finance.cashbox.all_info' }, {
        fromDate: normalized.startDate,
        toDate: normalized.endDate,
        page: pagination.page,
        limit: pagination.limit,
      }).catch(() => null),
      rmqSend(this.financeClient, { cmd: 'finance.cashbox.financial_balance' }, {}).catch(() => null),
    ]);

    const allInfoData = this.unwrap<any>(allInfo as any) as any;
    const balanceData = this.unwrap<any>(balance as any) as any;
    const histories = Array.isArray(allInfoData?.allCashboxHistories) ? allInfoData.allCashboxHistories : [];

    const totalIncome = histories
      .filter((h: any) => h?.operation_type === 'income')
      .reduce((sum: number, h: any) => sum + this.parseNumber(h?.amount), 0);
    const totalOutcome = histories
      .filter((h: any) => h?.operation_type === 'expense')
      .reduce((sum: number, h: any) => sum + this.parseNumber(h?.amount), 0);

    const monthlyMap = new Map<string, number>();
    for (const row of histories) {
      const createdAt = this.parseDateValue(row?.createdAt);
      if (!createdAt) continue;
      const key = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
      const delta = row?.operation_type === 'income'
        ? this.parseNumber(row?.amount)
        : -this.parseNumber(row?.amount);
      monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + delta);
    }

    const monthlyDynamics = Array.from(monthlyMap.entries())
      .map(([month, amount]) => ({ month, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return successRes(
      {
        range: normalized,
        totalIncome,
        totalOutcome,
        net: Number((totalIncome - totalOutcome).toFixed(2)),
        balances: balanceData,
        cashflowHistory: histories,
        monthlyDynamics,
        payables: {
          markets: this.parseNumber(balanceData?.markets?.marketsTotalBalans),
          couriers: this.parseNumber(balanceData?.couriers?.couriersTotalBalanse),
        },
      },
      200,
      'Finance report',
    );
  }

  async getCourierReport(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRangeAny(filter);
    const [courierStats, topCouriers] = await Promise.all([
      rmqSend(this.orderClient, { cmd: 'order.analytics.courier_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_couriers' }, { limit: 20 }),
    ]);

    const courierStatsData = Array.isArray(this.unwrap<any>(courierStats as any))
      ? (this.unwrap<any>(courierStats as any) as any[])
      : [];
    const topCouriersData = Array.isArray(this.unwrap<any>(topCouriers as any))
      ? (this.unwrap<any>(topCouriers as any) as any[])
      : [];

    const items = await Promise.all(
      courierStatsData.map(async (row) => {
        const courierId = String(row?.courier?.id ?? '');
        let detail: any = null;
        if (courierId) {
          detail = await rmqSend(
            this.orderClient,
            { cmd: 'order.analytics.courier_stat' },
            { requester: { id: courierId }, ...normalized },
          ).catch(() => null);
        }

        const detailData = this.unwrap<any>(detail as any) as any;
        return {
          courier: row?.courier ?? null,
          deliveredOrders: this.parseNumber(row?.soldOrders),
          cancelledOrders: this.parseNumber(
            detailData?.canceledOrders,
            Math.max(0, this.parseNumber(row?.totalOrders) - this.parseNumber(row?.soldOrders)),
          ),
          averageDeliveryHours: null,
          totalAmount: this.parseNumber(detailData?.profit),
          salaryEstimate: this.parseNumber(detailData?.profit),
          successRate: this.parseNumber(row?.successRate),
        };
      }),
    );

    if (this.roleSet(requester).has(Roles.COURIER)) {
      const requesterId = requester?.id ? String(requester.id) : '';
      return successRes(
        {
          range: normalized,
          items: items.filter((row) => String(row?.courier?.id ?? '') === requesterId),
          ranking: topCouriersData,
        },
        200,
        'Courier report',
      );
    }

    return successRes(
      {
        range: normalized,
        items,
        ranking: topCouriersData,
      },
      200,
      'Courier report',
    );
  }
}
