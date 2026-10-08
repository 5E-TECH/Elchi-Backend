import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Order_status,
  Roles,
  TASHKENT_OFFSET_MINUTES,
  endOfTashkentDay,
  parseDateOnly,
  rmqSend,
  startOfTashkentDay,
  startOfTashkentMonth,
  startOfTashkentWeek,
} from '@app/common';
import { errorRes, successRes } from '../../../libs/common/helpers/response';

interface RequesterContext {
  id: string;
  roles?: string[];
  branch_id?: string;
}

/**
 * Analytics javobiga chiqadigan market/kuryer obyekti (RBAC-02, CODE-08).
 * identity'ning to'liq qatori (telefon — login, username, tariflar, maosh,
 * komissiya, telegram_id, sozlamalar) dashboard javobiga TUSHMAYDI: FE faqat
 * `id` va `name` ni o'qiydi (entities/dashboard normalizeTopMarket /
 * normalizeTopCourier).
 */
interface AnalyticsPartyRef {
  id: string | null;
  name: string | null;
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

/** Moliyaviy hisobot `cashflowHistory` sahifasining yuqori chegarasi. */
const MAX_REPORT_PAGE_LIMIT = 100;

@Injectable()
export class AnalyticsServiceService {
  private static readonly COURIER_REPORT_TTL_MS = 30_000;

  private readonly logger = new Logger(AnalyticsServiceService.name);
  // Short-lived cache for getCourierReport. Dashboards refresh on a timer and
  // each render fans out N RMQ calls to order-service (one per courier). 30s
  // is short enough that the data still looks live, long enough to absorb
  // multiple operators hitting refresh in quick succession.
  // Proper fix: order.analytics.courier_stats_batch({ ids }) — separate sprint.
  private readonly courierReportCache = new Map<
    string,
    { data: any; expiresAt: number }
  >();

  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
  ) {}

  /**
   * Defense-in-depth for company-wide financial reports. The gateway already
   * restricts these routes to SUPERADMIN/ADMIN; this guards the RMQ entrypoint
   * too, so another internal caller (or a misconfigured route) can't leak
   * full financials to a lower-privileged role. (Audit 2026-06-07.)
   */
  private assertFinancialAccess(requester: RequesterContext | undefined): void {
    const roles = (requester?.roles ?? []).map((r) => String(r).toLowerCase());
    const allowed =
      roles.includes(Roles.SUPERADMIN) || roles.includes(Roles.ADMIN);
    if (!allowed) {
      throw new RpcException(
        errorRes('Bu hisobotni faqat admin koʻra oladi', 403),
      );
    }
  }

  private unwrap<T>(response: T | { data?: T }) {
    if (response && typeof response === 'object' && 'data' in response) {
      return (response as { data?: T }).data ?? response;
    }
    return response;
  }

  /**
   * `order.analytics.revenue` XOM `{ data: buckets[], summary }` qaytaradi
   * (successRes o'rami yo'q). Umumiy `unwrap` `'data'` kalitini ko'rib ichini
   * ochib yuborardi: summary yo'qolardi, bandlar massivi spread bilan
   * `{"0":…,"1":…}` obyektga aylanardi va KPI'da o'rtacha buyurtma qiymati
   * doim 0 chiqardi (faAfgvW1, tVAWnl9O). Uchala shakl qabul qilinadi: xom
   * `{data, summary}`, successRes o'rami va eski massiv.
   */
  private unwrapRevenue(response: unknown): {
    data: Array<Record<string, unknown>>;
    summary: Record<string, unknown> | null;
  } {
    if (Array.isArray(response)) {
      return {
        data: response as Array<Record<string, unknown>>,
        summary: null,
      };
    }
    if (!response || typeof response !== 'object') {
      return { data: [], summary: null };
    }
    const obj = response as { data?: unknown; summary?: unknown };
    if (Array.isArray(obj.data)) {
      return {
        data: obj.data as Array<Record<string, unknown>>,
        summary:
          obj.summary && typeof obj.summary === 'object'
            ? (obj.summary as Record<string, unknown>)
            : null,
      };
    }
    if (obj.data && typeof obj.data === 'object') {
      return this.unwrapRevenue(obj.data);
    }
    return { data: [], summary: null };
  }

  private normalizeDateRange(filter: { startDate?: string; endDate?: string }) {
    const { startDate, endDate } = filter;

    if (!startDate || !endDate) {
      const now = new Date();
      const start = startOfTashkentDay(now);
      const end = endOfTashkentDay(now);
      return {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      };
    }

    const startOnly = parseDateOnly(startDate);
    const endOnly = parseDateOnly(endDate);

    const start = startOnly
      ? startOfTashkentDay(startOnly)
      : new Date(startDate);
    const end = endOnly ? endOfTashkentDay(endOnly) : new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      const now = new Date();
      return {
        startDate: startOfTashkentDay(now).toISOString(),
        endDate: endOfTashkentDay(now).toISOString(),
      };
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  private normalizeDashboardDateRange(filter: {
    startDate?: string;
    endDate?: string;
    period?: string;
  }) {
    if (filter.startDate && filter.endDate) {
      return this.normalizeDateRange(filter);
    }

    const period = String(filter.period ?? 'today').toLowerCase();
    const now = new Date();
    const end = endOfTashkentDay(now);
    let start = startOfTashkentDay(now);

    // Tashkent day/week/month bounds come from the shared libs/common helper
    // (SqVMuhKo), so GET /orders and the dashboard read a day the same way.
    if (period === 'week') {
      start = startOfTashkentWeek(now);
    } else if (period === 'month') {
      start = startOfTashkentMonth(now);
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
      // Yuqori chegara (QGxC7v1E): limit=1000000 bitta so'rovda butun kassa
      // tarixini tortardi. Jami summalar endi limitga bog'liq emas.
      limit:
        Number.isFinite(limit) && limit > 0
          ? Math.min(limit, MAX_REPORT_PAGE_LIMIT)
          : 20,
    };
  }

  private roleSet(requester?: RequesterContext) {
    return new Set(
      (requester?.roles ?? []).map((role) => String(role).toLowerCase()),
    );
  }

  /** identity qatorini {id, name} ga qisqartiradi (RBAC-02, CODE-08). */
  private toPartyRef(value: unknown): AnalyticsPartyRef | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const row = value as { id?: unknown; name?: unknown };
    const id = row.id;
    return {
      id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
      name: typeof row.name === 'string' ? row.name : null,
    };
  }

  /**
   * market_stats / courier_stats qatorlaridagi `market` yoki `courier`
   * obyektini {id, name} ga qisqartiradi; hisob maydonlari o'zgarmaydi.
   * Massiv bo'lmagan javob (downstream xatosi → null) o'z holicha qaytadi.
   */
  private projectStatsRows(response: unknown, key: 'market' | 'courier') {
    const rows = this.unwrap<any>(response as any);
    if (!Array.isArray(rows)) {
      return rows;
    }
    return rows.map((row: any) => ({
      ...row,
      [key]: this.toPartyRef(row?.[key]),
    }));
  }

  /**
   * RBAC-02: market (va market operatori) dashboard'idagi `markets` FAQAT
   * so'rovchi marketning o'z qatori. Ilgari market_stats javobi butunligicha
   * qaytardi — har bir market boshqa barcha marketlarning telefoni (login),
   * username'i, tariflari va hajmini DevTools'da ko'rardi.
   */
  private ownMarketStatsRows(response: unknown, marketId: string) {
    const rows = this.projectStatsRows(response, 'market');
    if (!Array.isArray(rows) || !marketId) {
      return [];
    }
    return rows.filter(
      (row: any) => String(row?.market?.id ?? '') === marketId,
    );
  }

  /**
   * CODE-08 / C11: filial xodimi (MANAGER/REGISTRATOR/BRANCH) uchun o'z
   * filialining faol kuryerlari (branch_users, role COURIER). Filial
   * aniqlanmasa yoki branch-service javob bermasa — bo'sh to'plam
   * (fail-closed: kompaniya bo'yicha ro'yxat chiqmaydi).
   */
  private async resolveBranchCourierIds(
    requester: RequesterContext | undefined,
  ): Promise<Set<string>> {
    const branchId = await this.resolveRequesterBranchId(requester);
    if (!branchId) {
      return new Set();
    }

    const response = await rmqSend<any>(
      this.branchClient,
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: branchId, requester },
      { timeoutMs: 3000, retries: 1 },
    ).catch(() => null);
    const rows = this.unwrap<any>(response);
    if (!Array.isArray(rows)) {
      return new Set();
    }

    return new Set(
      rows
        .filter(
          (row: any) => String(row?.role ?? '').toUpperCase() === 'COURIER',
        )
        .map((row: any) => String(row?.user_id ?? '').trim())
        .filter(Boolean),
    );
  }

  /** `date` tushgan Toshkent oyi, 'YYYY-MM' (CODE-22: UTC oy emas). */
  private tashkentMonthKey(date: Date): string {
    const shifted = new Date(
      date.getTime() + TASHKENT_OFFSET_MINUTES * 60 * 1000,
    );
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private sanitizeDashboardOverview(overview: any, hideFinancials: boolean) {
    if (!hideFinancials || !overview || typeof overview !== 'object') {
      return overview;
    }

    const safeOverview = { ...overview };
    delete safeOverview.profit;
    delete safeOverview.totalRevenue;
    delete safeOverview.total_revenue;
    return safeOverview;
  }

  private normalizeRevenuePeriod(period?: string): RevenuePeriod {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (
      normalized === 'daily' ||
      normalized === 'weekly' ||
      normalized === 'monthly' ||
      normalized === 'yearly'
    ) {
      return normalized;
    }
    return 'daily';
  }

  private parseNumber(value: unknown, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  private extractBranchReceivable(branchesResponse: unknown) {
    const branchData = this.unwrap<any>(branchesResponse);
    const branches = Array.isArray(branchData?.items) ? branchData.items : [];

    return branches.reduce((sum: number, branch: any) => {
      if (String(branch?.type ?? '').toUpperCase() === 'HQ') {
        return sum;
      }

      const amount = this.parseNumber(branch?.olinishi_kerak);
      return sum + (amount > 0 ? amount : 0);
    }, 0);
  }

  private applyBranchReceivableToFinancialBalance(
    balanceData: any,
    branchReceivable: number,
  ) {
    if (!balanceData) {
      return balanceData;
    }

    const mainBalance = this.parseNumber(balanceData?.main?.balance);
    const marketPayable = this.parseNumber(
      balanceData?.markets?.marketPayable,
      Math.abs(this.parseNumber(balanceData?.markets?.marketsTotalBalans)),
    );
    const difference = branchReceivable - marketPayable;

    return {
      ...balanceData,
      currentSituation: mainBalance + difference,
      branches: {
        ...(balanceData.branches ?? {}),
        branchReceivable,
      },
      couriers: {
        ...(balanceData.couriers ?? {}),
        couriersTotalBalanse: branchReceivable,
      },
      difference,
    };
  }

  private parseDateValue(value?: string | number | Date | null) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private async requestOrderPage(query: Record<string, any>) {
    const response = await rmqSend<any>(
      this.orderClient,
      { cmd: 'order.find_all' },
      { query },
    );
    if (
      response &&
      typeof response === 'object' &&
      Array.isArray(response.data)
    ) {
      return {
        data: response.data as any[],
        total: this.parseNumber(response.total, 0),
        page: this.parseNumber(response.page, query.page ?? 1),
        limit: this.parseNumber(response.limit, query.limit ?? 20),
      };
    }

    const wrapped = this.unwrap<any>(response);
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

  private normalizePagedResponse(response: any): {
    items: any[];
    total: number;
    totalPages: number;
  } {
    const direct = this.unwrap<any>(response);
    const root = direct && typeof direct === 'object' ? direct : {};
    const items = Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.data?.items)
        ? root.data.items
        : [];
    const meta =
      root.meta ??
      root.pagination ??
      root.data?.meta ??
      root.data?.pagination ??
      {};
    const total = this.parseNumber(meta.total, items.length);
    const totalPages = this.parseNumber(
      meta.totalPages,
      Math.max(1, Math.ceil(total / Math.max(1, items.length || 1))),
    );
    return { items, total, totalPages };
  }

  private async resolveRequesterForMarket(
    requester: RequesterContext | undefined,
    roles: Set<string>,
  ): Promise<RequesterContext | undefined> {
    if (!requester || !roles.has(Roles.MARKET_OPERATOR)) {
      return requester;
    }

    const operatorRes = await rmqSend<any>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: requester.id },
    ).catch(() => null);
    const operatorData = this.unwrap<any>(operatorRes);
    const marketId = operatorData?.market_id;

    if (!marketId) {
      return requester;
    }

    return {
      ...requester,
      id: String(marketId),
    };
  }

  private async resolveRequesterBranchDashboard(
    requester: RequesterContext | undefined,
    filter: {
      startDate?: string;
      endDate?: string;
      period?: string;
      all?: boolean;
    } = {},
  ) {
    const branchId = await this.resolveRequesterBranchId(requester);
    if (!branchId) {
      return null;
    }

    const dashboardRes = await rmqSend<any>(
      this.branchClient,
      { cmd: 'branch.dashboard' },
      { id: branchId, requester, filter },
    ).catch(() => null);

    return this.unwrap<any>(dashboardRes) ?? null;
  }

  private async resolveRequesterBranchId(
    requester: RequesterContext | undefined,
  ): Promise<string | null> {
    if (!requester?.id) {
      return null;
    }
    if (requester.branch_id) {
      return String(requester.branch_id);
    }

    const assignmentRes = await rmqSend<any>(
      this.branchClient,
      { cmd: 'branch.user.find_by_user' },
      { user_id: requester.id, requester },
    ).catch(() => null);
    const assignmentData = this.unwrap<any>(assignmentRes);
    return assignmentData?.branch_id ? String(assignmentData.branch_id) : null;
  }

  async getDashboard(
    requester: RequesterContext | undefined,
    filter: {
      startDate?: string;
      endDate?: string;
      period?: string;
      all?: boolean;
    },
  ) {
    const isAllTime = filter.all === true;
    const normalized = isAllTime
      ? this.normalizeDashboardDateRange({
          startDate: '1970-01-01',
          endDate: new Date().toISOString(),
        })
      : this.normalizeDashboardDateRange(filter);
    const roles = this.roleSet(requester);
    const isRegistrator = roles.has(Roles.REGISTRATOR);
    const isBranchRole =
      roles.has(Roles.BRANCH) ||
      roles.has(Roles.MANAGER) ||
      roles.has(Roles.REGISTRATOR);
    const branchId = isBranchRole
      ? await this.resolveRequesterBranchId(requester)
      : null;
    const scopedRange = branchId
      ? { ...normalized, branch_id: branchId }
      : normalized;

    if (roles.has(Roles.COURIER)) {
      const myStat = await rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.courier_stat' },
        { requester, ...normalized },
      ).catch(() => null);
      const unwrappedMyStat = this.unwrap<any>(myStat);
      const courierScopedStats = unwrappedMyStat
        ? [
            {
              courier: { id: requester?.id },
              totalOrders: this.parseNumber(unwrappedMyStat.totalOrders),
              soldOrders: this.parseNumber(unwrappedMyStat.soldOrders),
              canceledOrders: this.parseNumber(unwrappedMyStat.canceledOrders),
              successRate: this.parseNumber(unwrappedMyStat.successRate),
            },
          ]
        : [];

      return successRes(
        {
          myStat: unwrappedMyStat,
          couriers: courierScopedStats,
          topCouriers: [],
        },
        200,
        'Dashboard infos',
      );
    }

    if (roles.has(Roles.MARKET) || roles.has(Roles.MARKET_OPERATOR)) {
      const marketRequester = await this.resolveRequesterForMarket(
        requester,
        roles,
      );
      const [myStat, markets, topMarkets, topOperators] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stat' },
          { requester: marketRequester, ...normalized },
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stats' },
          normalized,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_markets' },
          normalized,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_operators_by_market' },
          { requester: marketRequester },
        ).catch(() => []),
      ]);

      return successRes(
        {
          myStat: this.unwrap(myStat),
          markets: this.ownMarketStatsRows(
            markets,
            String(marketRequester?.id ?? ''),
          ),
          topMarkets: this.unwrap(topMarkets),
          topOperators: this.unwrap(topOperators as any),
        },
        200,
        'Dashboard infos',
      );
    }

    if (isAllTime) {
      const [orders, topMarkets, topBranches] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.overview' },
          scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_markets' },
          branchId ? { ...scopedRange, branch_id: branchId } : scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_branches' },
          branchId ? { ...scopedRange, branch_id: branchId } : scopedRange,
        ).catch(() => null),
      ]);
      const branchDashboard = isBranchRole
        ? await this.resolveRequesterBranchDashboard(requester, {
            ...scopedRange,
            period: filter.period,
            all: filter.all,
          })
        : null;

      return successRes(
        {
          orders: this.sanitizeDashboardOverview(
            this.unwrap(orders),
            isRegistrator,
          ),
          markets: [],
          couriers: [],
          topMarkets: this.unwrap(topMarkets),
          topBranches: this.unwrap(topBranches),
          branchDashboard,
        },
        200,
        'Dashboard infos (all time)',
      );
    }

    const [orders, markets, couriers, topMarkets, topBranches] =
      await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.overview' },
          scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stats' },
          scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stats' },
          scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_markets' },
          branchId ? { ...scopedRange, branch_id: branchId } : scopedRange,
        ).catch(() => null),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_branches' },
          branchId ? { ...scopedRange, branch_id: branchId } : scopedRange,
        ).catch(() => null),
      ]);
    const branchDashboard = isBranchRole
      ? await this.resolveRequesterBranchDashboard(requester, {
          ...normalized,
          period: filter.period,
          all: filter.all,
        })
      : null;

    const ordersOverview = this.unwrap<any>(orders as any);
    const safeOrdersOverview = this.sanitizeDashboardOverview(
      ordersOverview,
      isRegistrator,
    );

    return successRes(
      {
        orders: safeOrdersOverview,
        markets: this.projectStatsRows(markets, 'market'),
        couriers: this.projectStatsRows(couriers, 'courier'),
        topMarkets: this.unwrap(topMarkets),
        topBranches: this.unwrap(topBranches),
        branchDashboard,
      },
      200,
      'Dashboard infos',
    );
  }

  async getRevenueStats(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    const normalized = this.normalizeDateRangeAny(filter);
    const period = this.normalizeRevenuePeriod(filter.period);

    // Resilient fan-out: a failed/timed-out downstream degrades that leg to null
    // (handled by unwrap/?. below) instead of crashing the whole report.
    const [revenue, financialBalance, branchesResponse] = await Promise.all([
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.revenue' },
        { ...normalized, period },
      ).catch(() => null),
      rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.financial_balance' },
        {},
      ).catch(() => null),
      rmqSend(
        this.branchClient,
        { cmd: 'branch.find_all' },
        {
          requester,
          query: {
            status: 'active',
            page: 1,
            limit: 1000,
          },
        },
      ).catch(() => null),
    ]);

    const revenueData = this.unwrapRevenue(revenue);
    const branchReceivable = this.extractBranchReceivable(branchesResponse);
    const financeData = this.applyBranchReceivableToFinancialBalance(
      this.unwrap(financialBalance as any),
      branchReceivable,
    );
    const labels = revenueData.data.map((row) => row.label ?? row.period);
    const values = revenueData.data.map((row) => this.parseNumber(row.revenue));

    return successRes(
      {
        data: revenueData.data,
        summary: revenueData.summary,
        chart: { labels, values },
        finance: financeData,
      },
      200,
      `Revenue stats (${period})`,
    );
  }

  async getKpiStats(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    const normalized = this.normalizeDateRangeAny(filter);
    const rangeMs =
      new Date(normalized.endDate).getTime() -
      new Date(normalized.startDate).getTime();
    const revenuePeriod: RevenuePeriod =
      rangeMs > 5 * 365 * 24 * 60 * 60 * 1000
        ? 'yearly'
        : rangeMs > 90 * 24 * 60 * 60 * 1000
          ? 'monthly'
          : 'daily';
    const [overview, revenue, courierStats, topMarkets] = await Promise.all([
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.overview' },
        normalized,
      ).catch(() => null),
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.revenue' },
        { ...normalized, period: revenuePeriod },
      ).catch(() => null),
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.courier_stats' },
        normalized,
      ).catch(() => null),
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.top_markets' },
        { limit: 10 },
      ).catch(() => null),
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
    let onTimeCount = 0; // 24 soat ichida yetkazilganlar (SLA)
    const SLA_MS = 24 * 60 * 60 * 1000;
    for (const order of soldOrders) {
      const createdAt = this.parseDateValue(order?.createdAt);
      const soldAt = order?.sold_at ? new Date(Number(order.sold_at)) : null;
      if (!createdAt || !soldAt || Number.isNaN(soldAt.getTime())) continue;
      const diff = soldAt.getTime() - createdAt.getTime();
      if (diff > 0) {
        deliveryMsTotal += diff;
        deliveryCount += 1;
        if (diff <= SLA_MS) onTimeCount += 1;
      }
    }

    const overviewData = this.unwrap<any>(overview as any);
    const revenueData = this.unwrapRevenue(revenue);
    const courierStatsData = Array.isArray(
      this.unwrap<any>(courierStats as any),
    )
      ? (this.unwrap<any>(courierStats as any) as any[])
      : [];
    const topMarketsData = Array.isArray(this.unwrap<any>(topMarkets as any))
      ? (this.unwrap<any>(topMarkets as any) as any[])
      : [];

    const totalOrders = this.parseNumber(overviewData?.acceptedCount);
    const soldAndPaid = this.parseNumber(overviewData?.soldAndPaid);
    const cancelled = this.parseNumber(overviewData?.cancelled);
    // Dashboard "Umumiy tushum" bilan AYNI manba (overview) — o'rtacha qiymat
    // dashboarddagi totalRevenue/soldAndPaid bilan bir xil chiqsin
    // (tVAWnl9O TC2); overview'da bo'lmasa revenue summary zaxira.
    const totalRevenue = this.parseNumber(
      overviewData?.totalRevenue ?? revenueData.summary?.totalRevenue,
    );
    const avgOrderValue =
      soldAndPaid > 0 ? Number((totalRevenue / soldAndPaid).toFixed(2)) : 0;
    const fulfillmentHours =
      deliveryCount > 0
        ? Number(
            (deliveryMsTotal / deliveryCount / (1000 * 60 * 60)).toFixed(2),
          )
        : 0;
    const onTimeRate =
      deliveryCount > 0
        ? Number(((onTimeCount * 100) / deliveryCount).toFixed(2))
        : 0;
    const cancellationRate =
      totalOrders > 0
        ? Number(((cancelled * 100) / totalOrders).toFixed(2))
        : 0;
    const courierEfficiency =
      courierStatsData.length > 0
        ? Number(
            (
              courierStatsData.reduce(
                (sum, row) => sum + this.parseNumber(row.totalOrders),
                0,
              ) / courierStatsData.length
            ).toFixed(2),
          )
        : 0;

    return successRes(
      {
        averageOrderValue: avgOrderValue,
        averageFulfillmentHours: fulfillmentHours,
        onTimeRate,
        cancellationRate,
        courierEfficiency,
        marketRating: topMarketsData,
      },
      200,
      'KPI stats',
    );
  }

  async getOrderReport(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    const normalized = this.normalizeDateRangeAny(filter);
    const [overview, topMarkets] = await Promise.all([
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.overview' },
        normalized,
      ).catch(() => null),
      rmqSend(
        this.orderClient,
        { cmd: 'order.analytics.top_markets' },
        { limit: 10 },
      ).catch(() => null),
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
    const statusDistribution = statuses.reduce<Record<string, number>>(
      (acc, status, index) => {
        acc[status] = counts[index];
        return acc;
      },
      {},
    );

    const allOrders = await this.collectOrders({
      start_day: normalized.startDate,
      end_day: normalized.endDate,
    });

    const regionMap = new Map<string, number>();
    const productMap = new Map<
      string,
      { product_id: string; total_quantity: number }
    >();
    for (const order of allOrders.items) {
      const regionId = String(order?.region_id ?? 'unknown');
      regionMap.set(regionId, (regionMap.get(regionId) ?? 0) + 1);

      const items = Array.isArray(order?.items) ? order.items : [];
      for (const item of items) {
        const productId = String(item?.product_id ?? 'unknown');
        const quantity = this.parseNumber(item?.quantity, 1);
        const current = productMap.get(productId) ?? {
          product_id: productId,
          total_quantity: 0,
        };
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
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    const normalized = this.normalizeDateRangeAny(filter);
    const pagination = this.normalizePagination(filter);
    const [allInfo, balance, branchesResponse] = await Promise.all([
      rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.all_info' },
        {
          fromDate: normalized.startDate,
          toDate: normalized.endDate,
          page: pagination.page,
          limit: pagination.limit,
          withTotals: true,
        },
      ).catch(() => null),
      rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.financial_balance' },
        {},
      ).catch(() => null),
      rmqSend(
        this.branchClient,
        { cmd: 'branch.find_all' },
        {
          requester,
          query: {
            status: 'active',
            page: 1,
            limit: 1000,
          },
        },
      ).catch(() => null),
    ]);

    const allInfoData = this.unwrap<any>(allInfo as any);
    const branchReceivable = this.extractBranchReceivable(branchesResponse);
    const balanceData = this.applyBranchReceivableToFinancialBalance(
      this.unwrap<any>(balance as any),
      branchReceivable,
    );
    const histories = Array.isArray(allInfoData?.allCashboxHistories)
      ? allInfoData.allCashboxHistories
      : [];

    /**
     * QGxC7v1E: jami va oylik summalar finance-service'da BUTUN oraliq
     * bo'yicha (SQL) hisoblanadi. Ilgari shu yerda sahifa (20 qator) ustidan
     * yig'ilardi — net ishorasi limitga qarab o'zgarardi. Eski finance javobi
     * (periodTotals yo'q) uchun sahifa bo'yicha hisob zaxira sifatida qoladi.
     */
    const periodTotals = allInfoData?.periodTotals as
      | { income?: number; outcome?: number }
      | undefined;
    const periodMonthly = Array.isArray(allInfoData?.periodMonthly)
      ? (allInfoData.periodMonthly as Array<{ month: string; amount: number }>)
      : null;

    const totalIncome = periodTotals
      ? this.parseNumber(periodTotals.income)
      : histories
          .filter((h: any) => h?.operation_type === 'income')
          .reduce(
            (sum: number, h: any) => sum + this.parseNumber(h?.amount),
            0,
          );
    const totalOutcome = periodTotals
      ? this.parseNumber(periodTotals.outcome)
      : histories
          .filter((h: any) => h?.operation_type === 'expense')
          .reduce(
            (sum: number, h: any) => sum + this.parseNumber(h?.amount),
            0,
          );

    const monthlyMap = new Map<string, number>();
    if (periodMonthly) {
      for (const row of periodMonthly) {
        monthlyMap.set(row.month, this.parseNumber(row.amount));
      }
    } else {
      for (const row of histories) {
        const createdAt = this.parseDateValue(row?.createdAt);
        if (!createdAt) continue;
        const key = this.tashkentMonthKey(createdAt);
        const delta =
          row?.operation_type === 'income'
            ? this.parseNumber(row?.amount)
            : -this.parseNumber(row?.amount);
        monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + delta);
      }
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
          couriers: this.parseNumber(
            balanceData?.couriers?.couriersTotalBalanse,
          ),
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
    const roles = this.roleSet(requester);
    const isCourier = roles.has(Roles.COURIER);
    const isPrivileged = roles.has(Roles.SUPERADMIN) || roles.has(Roles.ADMIN);

    // CODE-08 / C11: menejer, registrator (va BRANCH) kompaniya bo'yicha
    // hisobotni EMAS, faqat o'z filiali kuryerlarini ko'radi. Ruxsat to'plami
    // og'ir hisobdan OLDIN olinadi: filial aniqlanmasa — darhol bo'sh javob
    // (fail-closed), N+1 hisob umuman boshlanmaydi.
    const branchCourierIds =
      !isCourier && !isPrivileged
        ? await this.resolveBranchCourierIds(requester)
        : null;
    if (branchCourierIds && branchCourierIds.size === 0) {
      return successRes(
        { range: normalized, items: [], ranking: [] },
        200,
        'Courier report',
      );
    }

    // Cache key intentionally ignores requester — the heavy N+1 work is
    // role-independent (we return the same items[]/ranking[]; only the
    // final filter step at the end differs per requester).
    const cacheKey = `${normalized.startDate ?? ''}|${normalized.endDate ?? ''}`;
    const now = Date.now();
    const cached = this.courierReportCache.get(cacheKey);
    let items: any[];
    let topCouriersData: any[];

    if (cached && cached.expiresAt > now) {
      items = cached.data.items;
      topCouriersData = cached.data.ranking;
    } else {
      const [courierStats, topCouriers] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stats' },
          normalized,
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_couriers' },
          { limit: 20 },
        ),
      ]);

      const courierStatsData = Array.isArray(
        this.unwrap<any>(courierStats as any),
      )
        ? (this.unwrap<any>(courierStats as any) as any[])
        : [];
      topCouriersData = Array.isArray(this.unwrap<any>(topCouriers as any))
        ? (this.unwrap<any>(topCouriers as any) as any[])
        : [];

      items = await Promise.all(
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

          const detailData = this.unwrap<any>(detail);
          return {
            // CODE-08: identity'ning to'liq kuryer qatori (telefon, maosh,
            // tariflar) emas — faqat {id, name}.
            courier: this.toPartyRef(row?.courier),
            deliveredOrders: this.parseNumber(row?.soldOrders),
            cancelledOrders: this.parseNumber(
              detailData?.canceledOrders,
              Math.max(
                0,
                this.parseNumber(row?.totalOrders) -
                  this.parseNumber(row?.soldOrders),
              ),
            ),
            averageDeliveryHours: null,
            totalAmount: this.parseNumber(detailData?.profit),
            salaryEstimate: this.parseNumber(detailData?.profit),
            successRate: this.parseNumber(row?.successRate),
          };
        }),
      );

      // Opportunistic eviction to keep the map bounded.
      for (const [key, entry] of this.courierReportCache.entries()) {
        if (entry.expiresAt <= now) {
          this.courierReportCache.delete(key);
        }
      }

      this.courierReportCache.set(cacheKey, {
        data: { items, ranking: topCouriersData },
        expiresAt: now + AnalyticsServiceService.COURIER_REPORT_TTL_MS,
      });
    }

    if (isCourier) {
      const requesterId = requester?.id ? String(requester.id) : '';
      return successRes(
        {
          range: normalized,
          items: items.filter(
            (row) => String(row?.courier?.id ?? '') === requesterId,
          ),
          ranking: topCouriersData,
        },
        200,
        'Courier report',
      );
    }

    if (branchCourierIds) {
      return successRes(
        {
          range: normalized,
          items: items.filter((row) =>
            branchCourierIds.has(String(row?.courier?.id ?? '')),
          ),
          ranking: topCouriersData.filter((row) =>
            branchCourierIds.has(String(row?.courier_id ?? '')),
          ),
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
