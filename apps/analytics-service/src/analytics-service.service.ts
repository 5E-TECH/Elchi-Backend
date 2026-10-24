import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Order_status,
  Roles,
  RmqSendOptions,
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
  // (XdKajqLe) «Barchasi» — /analytics/kpi va /analytics/revenue.
  all?: boolean;
}

type RevenuePeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Moliyaviy hisobot `cashflowHistory` sahifasining yuqori chegarasi. */
const MAX_REPORT_PAGE_LIMIT = 100;
/**
 * (VkwhHqvW) Analitika o'qish chaqiruvlari: bitta urinish, 2,5 s. Dashboard
 * eng ko'pi IKKI ketma-ket bosqich (rol aniqlash → parallel bo'laklar) =
 * 5 s < gateway `timeout(8000)`; KPI/revenue — bitta parallel bosqich.
 * `analytics-budget.spec.ts` buni sekin order-service bilan tekshiradi.
 */
export const ANALYTICS_READ_OPTIONS = Object.freeze({
  timeoutMs: 2500,
  retries: 0,
  deadlineMs: 2500,
});

/**
 * (W20LoskP) "Buyurtmalar hisoboti" (`getOrderReport`): bitta PARALLEL
 * bosqich (5 ta SQL agregat), 8 s < gateway `timeout(12000)`. Hisobot oynasi
 * dashboarddan keng (366 kungacha), shuning uchun 2,5 s emas.
 */
export const REPORT_READ_OPTIONS = Object.freeze({
  timeoutMs: 8000,
  retries: 0,
  deadlineMs: 8000,
});

/** (5tUEVG1B) Kuryer dashboardidagi reytingda ko'rsatiladigan qatorlar. */
const COURIER_LEADERBOARD_SIZE = 10;
/**
 * Kuryer o'z o'rnini (`myRank`) top-10 dan tashqarida ham bilishi uchun
 * order-service'dan so'raladigan to'liq reyting chegarasi (kuryerlar soni).
 */
const COURIER_LEADERBOARD_SCAN_LIMIT = 500;
/**
 * (9zbSDkUI, 1-variant) Admin/filial dashboardida bitta Toshkent kuni
 * tanlanganda "Top marketlar"/"Top filiallar" shu kun bilan tugaydigan oxirgi
 * N kun bo'yicha olinadi (BeePost "Last 30 Days" naqshi).
 */
const DASHBOARD_RANKING_FALLBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * (l9NNdsCH) Dashboard maqsad qiymatlari (maket G1: «maqsad 80%»).
 * Minimal variant: sozlama jadvali yo'q — qotirilgan qiymat, javobda
 * `targets` sifatida (FE «Yaxshi chegarasi · 70%» o'rniga shuni chizadi).
 */
export const DASHBOARD_TARGETS = Object.freeze({ successRate: 80 });

/** Dashboard reyting oynasi qaysi qoida bilan tanlangani (FE yorlig'i uchun). */
type DashboardRankingRule = 'last_30_days' | 'selected_range';

interface DashboardRankingWindow {
  startDate: string;
  endDate: string;
  period_rule: DashboardRankingRule;
  period_days: number | null;
  selected_from: string;
  selected_to: string;
}

@Injectable()
export class AnalyticsServiceService {
  private static readonly COURIER_REPORT_TTL_MS = 30_000;

  private readonly logger = new Logger(AnalyticsServiceService.name);
  // Short-lived cache for getCourierReport. 30s is short enough that the data
  // still looks live, long enough to absorb multiple operators hitting
  // refresh in quick succession. juZFa64U: the per-courier N+1 is gone
  // (`courier_stats {include_detail: true}` — one batched RPC), so the cache
  // is now only an extra speed-up, not the main protection.
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

  private async readPart(
    client: ClientProxy,
    cmd: string,
    payload: unknown,
    failedParts: string[],
    part: string,
    options: RmqSendOptions = ANALYTICS_READ_OPTIONS,
  ): Promise<unknown> {
    try {
      const result = await rmqSend(client, { cmd }, payload, options);
      if (result !== null && result !== undefined) return result;
    } catch (error) {
      this.logger.warn(
        `Analytics ${part} olinmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    failedParts.push(part);
    return null;
  }

  private requirePart(value: unknown, part: string): void {
    if (value === null) {
      throw new RpcException({
        statusCode: 503,
        message: `Analitika ${part} ma'lumoti hozir olinmadi`,
      });
    }
  }

  /**
   * (uN1tjjGu) "Barchasi" (`all=true`) javobining oyna meta'si. order-service
   * butun davrni eng so'nggi `max_span_days` kunga qisqartiradi (audit C3) —
   * javob buni JIM qoldirmaydi: `clamped`, `effective_from`, `effective_to`
   * (qo'llangan oyna, ISO) va xabar "oxirgi N kun". Eski order-service
   * (`applied_range` yo'q) — `null`.
   */
  private allTimeRangeMeta(source: unknown): {
    meta: {
      clamped: boolean | null;
      effective_from: string | null;
      effective_to: string | null;
      max_span_days: number | null;
    };
    message: string;
  } {
    const applied =
      source && typeof source === 'object'
        ? ((source as { applied_range?: unknown }).applied_range as
            | Record<string, unknown>
            | null
            | undefined)
        : null;
    const clamped =
      typeof applied?.clamped === 'boolean' ? applied.clamped : null;
    const maxSpanDays =
      typeof applied?.max_span_days === 'number' &&
      Number.isFinite(applied.max_span_days)
        ? applied.max_span_days
        : null;
    const message =
      clamped === true
        ? `Dashboard infos (oxirgi ${maxSpanDays ?? '?'} kun)`
        : clamped === false
          ? 'Dashboard infos (barcha tarix)'
          : 'Dashboard infos (all time)';
    return {
      meta: {
        clamped,
        effective_from:
          typeof applied?.applied_from === 'string'
            ? applied.applied_from
            : null,
        effective_to:
          typeof applied?.applied_to === 'string' ? applied.applied_to : null,
        max_span_days: maxSpanDays,
      },
      message,
    };
  }

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

  /**
   * (XdKajqLe) KPI/revenue oynasi. `all=true` («Barchasi») — dashboard
   * bilan AYNI: 1970-01-01 → hozir, order-service'ga `all: true` (u eng
   * so'nggi 366 kunga qisqartiradi va `applied_range` qaytaradi — javobda
   * `clamped`/`effective_*`). Aks holda — oldingidek tanlangan davr.
   */
  private kpiRange(filter: RevenueFilter = {}): {
    startDate: string;
    endDate: string;
    all?: true;
  } {
    if (filter.all === true) {
      return {
        ...this.normalizeDateRange({
          startDate: '1970-01-01',
          endDate: new Date().toISOString(),
        }),
        all: true,
      };
    }
    return this.normalizeDateRangeAny(filter);
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
   * (PQt3n1N0, 9zbSDkUI) `include_meta` reyting javobi: qatorlar + meta
   * (`min_orders`, `filtered_out`, reyting davri `from`/`to`). Eski
   * order-service massiv qaytarsa — meta `null`.
   */
  private ranking(response: unknown): {
    items: any[];
    meta: {
      min_orders: number;
      filtered_out: number;
      from: string | null;
      to: string | null;
    } | null;
  } {
    const value = this.unwrap<any>(response as any);
    if (Array.isArray(value)) return { items: value, meta: null };
    const items = Array.isArray(value?.items) ? value.items : [];
    const meta =
      Number.isFinite(value?.min_orders) && Number.isFinite(value?.filtered_out)
        ? {
            min_orders: Number(value.min_orders),
            filtered_out: Number(value.filtered_out),
            from: typeof value.from === 'string' ? value.from : null,
            to: typeof value.to === 'string' ? value.to : null,
          }
        : null;
    return { items, meta };
  }

  /**
   * (9zbSDkUI, 1-variant) Admin/filial dashboardidagi `top_markets` /
   * `top_branches` oynasi. Tanlangan davr bitta Toshkent kalendar kuni bo'lsa
   * (standart "Bugun", sanasiz so'rov yoki startDate=endDate) — reyting shu kun
   * bilan tugaydigan oxirgi 30 kun bo'yicha (kunlik ko'rinishda kartalar bo'sh
   * turmasin). 2+ kunlik davr (shu jumladan `all=true`) — AYNAN tanlangan davr
   * (PQt3n1N0: 01.09–18.09 reytingi shu davrdan). `selected_*` — foydalanuvchi
   * tanlagan davr, reytingning haqiqiy oynasi esa meta `from`/`to` da.
   */
  private dashboardRankingWindow(normalized: {
    startDate: string;
    endDate: string;
  }): DashboardRankingWindow {
    const start = new Date(normalized.startDate);
    const end = new Date(normalized.endDate);
    const selected = {
      selected_from: normalized.startDate,
      selected_to: normalized.endDate,
    };
    const isSingleTashkentDay =
      start.getTime() <= end.getTime() &&
      startOfTashkentDay(end).getTime() <= start.getTime();
    if (!isSingleTashkentDay) {
      return {
        startDate: normalized.startDate,
        endDate: normalized.endDate,
        period_rule: 'selected_range',
        period_days: null,
        ...selected,
      };
    }
    const from = new Date(
      startOfTashkentDay(end).getTime() -
        (DASHBOARD_RANKING_FALLBACK_DAYS - 1) * DAY_MS,
    );
    return {
      startDate: from.toISOString(),
      endDate: normalized.endDate,
      period_rule: 'last_30_days',
      period_days: DASHBOARD_RANKING_FALLBACK_DAYS,
      ...selected,
    };
  }

  /** `ranking()` meta'siga dashboard reyting qoidasini qo'shadi (9zbSDkUI). */
  private dashboardRanking(response: unknown, window: DashboardRankingWindow) {
    const { items, meta } = this.ranking(response);
    return {
      items,
      meta: meta
        ? {
            ...meta,
            period_rule: window.period_rule,
            period_days: window.period_days,
            selected_from: window.selected_from,
            selected_to: window.selected_to,
          }
        : null,
    };
  }

  /**
   * (5tUEVG1B) Kuryer dashboardidagi reyting. Maxfiylik: boshqa kuryerlarning
   * PUL maydonlari (profit, maosh, tarif) va identity qatori YUBORILMAYDI —
   * order-service javobidan qat'i nazar faqat oq ro'yxatdagi 5 maydon.
   * `myRank` — so'rovchining to'liq reytingdagi o'rni (chegaradan o'tmagan
   * yoki davrda buyurtmasi yo'q bo'lsa `null`), `myRanking` — o'z qatori.
   */
  private courierLeaderboard(response: unknown, requesterId: string) {
    const { items, meta } = this.ranking(response);
    const rows = items.map((row: any) => ({
      courier_id:
        row?.courier_id !== null && row?.courier_id !== undefined
          ? String(row.courier_id)
          : null,
      courier_name:
        typeof row?.courier_name === 'string' ? row.courier_name : null,
      total_orders: this.parseNumber(row?.total_orders),
      successful_orders: this.parseNumber(row?.successful_orders),
      success_rate: this.parseNumber(row?.success_rate),
    }));
    const index = requesterId
      ? rows.findIndex((row) => row.courier_id === requesterId)
      : -1;
    return {
      items: rows.slice(0, COURIER_LEADERBOARD_SIZE),
      meta,
      myRank: index >= 0 ? index + 1 : null,
      myRanking: index >= 0 ? rows[index] : null,
    };
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
      ANALYTICS_READ_OPTIONS,
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
    // (l9NNdsCH) bekor summasi ham moliyaviy ko'rsatkich.
    delete safeOverview.lostRevenue;
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

    // (VkwhHqvW) identity javob bermasa — 503. Ilgari xato `null` ga
    // yutilardi va operator O'Z user id'si market id deb olinib, dashboard
    // soxta nollar bilan 200 qaytarardi. Marketi umuman yo'q operator
    // (javob bor, `market_id` yo'q) — avvalgidek bo'sh ro'yxat (fail-closed).
    const operatorRes = await rmqSend<any>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: requester.id },
      ANALYTICS_READ_OPTIONS,
    ).catch((error: unknown) => {
      this.logger.warn(
        `Analytics market operatori aniqlanmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new RpcException({
        statusCode: 503,
        message: "Analitika market ma'lumoti hozir olinmadi",
      });
    });
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

  /**
   * (VkwhHqvW) Filial dashboard'i — filial id ALLAQACHON aniqlangan.
   * Ilgari bu yerda filial yana qaytadan aniqlanardi va chaqiruv 5 ta
   * order bo'lagidan KEYIN ketma-ket bajarilardi: filial roli uchun eng
   * yomon holat 4 × 2,5 s = 10 s — gateway'ning 8 s chegarasidan uzun.
   * Endi u order bo'laklari bilan PARALLEL ketadi.
   */
  private async fetchBranchDashboard(
    branchId: string,
    requester: RequesterContext | undefined,
    filter: {
      startDate?: string;
      endDate?: string;
      period?: string;
      all?: boolean;
    },
  ) {
    const dashboardRes = await rmqSend<any>(
      this.branchClient,
      { cmd: 'branch.dashboard' },
      { id: branchId, requester, filter },
      ANALYTICS_READ_OPTIONS,
    ).catch(() => null);

    return this.unwrap<any>(dashboardRes) ?? null;
  }

  /**
   * So'rovchining filiali: avval JWT `branch_id`, bo'lmasa branch-service.
   * `failClosed` (dashboard): branch-service javob bermasa 503 — filial
   * doirasini aniqlay olmagan holda kompaniya bo'yicha raqamlar chiqmasin
   * (VkwhHqvW: 2,5 s / qayta urinishsiz rejimda bu ehtimol oshgan edi).
   */
  private async resolveRequesterBranchId(
    requester: RequesterContext | undefined,
    failClosed = false,
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
      ANALYTICS_READ_OPTIONS,
    ).catch((error: unknown) => {
      if (!failClosed) return null;
      this.logger.warn(
        `Analytics filial aniqlanmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new RpcException({
        statusCode: 503,
        message: "Analitika filial ma'lumoti hozir olinmadi",
      });
    });
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
      // (6CYRjoZG) faqat SUPERADMIN/ADMIN uchun: `/branches/:id` «Filial
      // ko'rsatkichlari». Boshqa rollarda e'tiborsiz (filial xodimi doim
      // o'z filiali, kuryer/market — o'z kesimi).
      branch_id?: string;
    },
  ) {
    const isAllTime = filter.all === true;
    const failedParts: string[] = [];
    const normalized = isAllTime
      ? this.normalizeDashboardDateRange({
          startDate: '1970-01-01',
          endDate: new Date().toISOString(),
        })
      : this.normalizeDashboardDateRange(filter);
    const dashboardRange = {
      ...normalized,
      ...(isAllTime ? { all: true } : {}),
    };
    const roles = this.roleSet(requester);
    const isRegistrator = roles.has(Roles.REGISTRATOR);
    const isBranchRole =
      roles.has(Roles.BRANCH) ||
      roles.has(Roles.MANAGER) ||
      roles.has(Roles.REGISTRATOR);
    // (6CYRjoZG) SA/ADMIN `?branch_id=` bilan — tanlangan filial kesimi
    // (overview/market/kuryer jadvallari, reytinglar + quyidagi qo'shimcha
    // bo'laklar). Filial roli bo'lsa — baribir O'Z filiali (yuqorida).
    const isAdminRole = roles.has(Roles.SUPERADMIN) || roles.has(Roles.ADMIN);
    const requestedBranchId =
      typeof filter.branch_id === 'string' ? filter.branch_id.trim() : '';
    const adminBranchId =
      !isBranchRole && isAdminRole && requestedBranchId
        ? requestedBranchId
        : null;
    // (VkwhHqvW) filial aniqlanmasa (branch-service xatosi) — 503, kompaniya
    // bo'yicha raqamlar emas.
    const branchId = isBranchRole
      ? await this.resolveRequesterBranchId(requester, true)
      : adminBranchId;
    const scopedRange = branchId
      ? {
          ...dashboardRange,
          branch_id: branchId,
        }
      : dashboardRange;

    if (roles.has(Roles.COURIER)) {
      // (5tUEVG1B) kuryer o'z o'rnini ko'rsin: reyting tanlangan davr
      // bo'yicha `order.analytics.top_couriers` dan (PQt3n1N0), parallel.
      const [myStat, topCouriersRes] = await Promise.all([
        this.readPart(
          this.orderClient,
          'order.analytics.courier_stat',
          { requester, ...dashboardRange },
          failedParts,
          'myStat',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_couriers',
          {
            ...dashboardRange,
            limit: COURIER_LEADERBOARD_SCAN_LIMIT,
            include_meta: true,
          },
          failedParts,
          'topCouriers',
        ),
      ]);
      this.requirePart(myStat, 'myStat');
      const leaderboard = this.courierLeaderboard(
        topCouriersRes,
        String(requester?.id ?? ''),
      );
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

      const courierAllTime = isAllTime
        ? this.allTimeRangeMeta(unwrappedMyStat)
        : null;
      return successRes(
        {
          myStat: unwrappedMyStat,
          couriers: courierScopedStats,
          topCouriers: leaderboard.items,
          topCouriersMeta: leaderboard.meta,
          myRank: leaderboard.myRank,
          myRanking: leaderboard.myRanking,
          degraded: failedParts.length > 0,
          failed_parts: failedParts.sort(),
          ...(courierAllTime?.meta ?? {}),
        },
        200,
        courierAllTime?.message ?? 'Dashboard infos',
      );
    }

    if (roles.has(Roles.MARKET) || roles.has(Roles.MARKET_OPERATOR)) {
      const marketRequester = await this.resolveRequesterForMarket(
        requester,
        roles,
      );
      const [myStat, markets, topMarkets, topOperators] = await Promise.all([
        this.readPart(
          this.orderClient,
          'order.analytics.market_stat',
          { requester: marketRequester, ...dashboardRange },
          failedParts,
          'myStat',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.market_stats',
          dashboardRange,
          failedParts,
          'markets',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_markets',
          { ...dashboardRange, include_meta: true },
          failedParts,
          'topMarkets',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_operators_by_market',
          { requester: marketRequester },
          failedParts,
          'topOperators',
        ),
      ]);
      this.requirePart(myStat, 'myStat');
      const unwrappedMarketStat = this.unwrap<any>(myStat);
      const marketAllTime = isAllTime
        ? this.allTimeRangeMeta(unwrappedMarketStat)
        : null;

      return successRes(
        {
          myStat: unwrappedMarketStat,
          markets: this.ownMarketStatsRows(
            markets,
            String(marketRequester?.id ?? ''),
          ),
          topMarkets: this.ranking(topMarkets).items,
          topMarketsMeta: this.ranking(topMarkets).meta,
          topOperators: this.unwrap(topOperators as any) ?? [],
          degraded: failedParts.length > 0,
          failed_parts: failedParts.sort(),
          ...(marketAllTime?.meta ?? {}),
        },
        200,
        marketAllTime?.message ?? 'Dashboard infos',
      );
    }

    const branchDashboardFilter = {
      ...normalized,
      period: filter.period,
      all: filter.all,
    };
    // (9zbSDkUI) reytinglar oynasi: 1 kun → oxirgi 30 kun, aks holda tanlangan
    // davr. Filial doirasi (`branch_id`) va `all` bayrog'i saqlanadi.
    const rankingWindow = this.dashboardRankingWindow(normalized);
    const rankingRange = {
      ...scopedRange,
      startDate: rankingWindow.startDate,
      endDate: rankingWindow.endDate,
      include_meta: true,
    };
    // (6CYRjoZG) SA/ADMIN filial ko'rinishi: «Kunlik daromad», holat donut,
    // «Kuryerlar reytingi» — xuddi shu parallel bosqichda (byudjet o'zgarmaydi).
    const isAdminBranchView = adminBranchId !== null;
    const [
      orders,
      markets,
      couriers,
      topMarkets,
      topBranches,
      branchDashboard,
      dailyRevenue,
      statusDistribution,
      topCouriers,
    ] = await Promise.all([
      this.readPart(
        this.orderClient,
        'order.analytics.overview',
        scopedRange,
        failedParts,
        'overview',
      ),
      this.readPart(
        this.orderClient,
        'order.analytics.market_stats',
        scopedRange,
        failedParts,
        'markets',
      ),
      this.readPart(
        this.orderClient,
        'order.analytics.courier_stats',
        scopedRange,
        failedParts,
        'couriers',
      ),
      this.readPart(
        this.orderClient,
        'order.analytics.top_markets',
        rankingRange,
        failedParts,
        'topMarkets',
      ),
      this.readPart(
        this.orderClient,
        'order.analytics.top_branches',
        rankingRange,
        failedParts,
        'topBranches',
      ),
      (isBranchRole || isAdminBranchView) && branchId
        ? this.fetchBranchDashboard(branchId, requester, branchDashboardFilter)
        : Promise.resolve(null),
      isAdminBranchView
        ? this.readPart(
            this.orderClient,
            'order.analytics.revenue',
            { ...normalized, period: 'daily', branch_id: branchId },
            failedParts,
            'dailyRevenue',
          )
        : Promise.resolve(null),
      isAdminBranchView
        ? this.readPart(
            this.orderClient,
            'order.analytics.status_distribution',
            { ...normalized, branch_id: branchId },
            failedParts,
            'statusDistribution',
          )
        : Promise.resolve(null),
      isAdminBranchView
        ? this.readPart(
            this.orderClient,
            'order.analytics.top_couriers',
            { ...rankingRange, limit: COURIER_LEADERBOARD_SIZE },
            failedParts,
            'topCouriers',
          )
        : Promise.resolve(null),
    ]);
    this.requirePart(orders, 'overview');
    if (
      (isBranchRole || isAdminBranchView) &&
      branchId &&
      branchDashboard === null
    ) {
      failedParts.push('branchDashboard');
    }

    const ordersOverview = this.unwrap<any>(orders as any);
    const safeOrdersOverview = this.sanitizeDashboardOverview(
      ordersOverview,
      isRegistrator,
    );
    const allTime = isAllTime ? this.allTimeRangeMeta(ordersOverview) : null;
    const topMarketsRanking = this.dashboardRanking(topMarkets, rankingWindow);
    const topBranchesRanking = this.dashboardRanking(
      topBranches,
      rankingWindow,
    );

    return successRes(
      {
        orders: safeOrdersOverview,
        markets: this.projectStatsRows(markets, 'market'),
        couriers: this.projectStatsRows(couriers, 'courier'),
        topMarkets: topMarketsRanking.items,
        topMarketsMeta: topMarketsRanking.meta,
        topBranches: topBranchesRanking.items,
        topBranchesMeta: topBranchesRanking.meta,
        branchDashboard,
        // (l9NNdsCH) maqsad qiymati (muvaffaqiyat ulushi, %).
        targets: DASHBOARD_TARGETS,
        ...(isAdminBranchView
          ? this.adminBranchViewParts(
              branchId as string,
              dailyRevenue,
              statusDistribution,
              topCouriers,
              rankingWindow,
            )
          : {}),
        degraded: failedParts.length > 0,
        failed_parts: failedParts.sort(),
        ...(allTime?.meta ?? {}),
      },
      200,
      allTime?.message ?? 'Dashboard infos',
    );
  }

  /**
   * (6CYRjoZG) SA/ADMIN `?branch_id=` javobining qo'shimcha bo'laklari
   * (`/branches/:id` «Filial ko'rsatkichlari»): `branch_id` (qo'llangan
   * filial), `dailyRevenue` (kunlik daromad bandlari, `/analytics/revenue`
   * `data` bilan bir xil shakl), `statusDistribution` (holat → son, donut) va
   * `topCouriers` (filial kuryerlari reytingi, ≥ min_orders). Bo'lak
   * olinmasa — `null` + `failed_parts` (degraded).
   */
  private adminBranchViewParts(
    branchId: string,
    dailyRevenue: unknown,
    statusDistribution: unknown,
    topCouriers: unknown,
    rankingWindow: DashboardRankingWindow,
  ) {
    const revenue =
      dailyRevenue === null ? null : this.unwrapRevenue(dailyRevenue);
    const status = this.unwrap<any>(statusDistribution as any);
    const couriersRanking = this.dashboardRanking(topCouriers, rankingWindow);
    return {
      branch_id: branchId,
      dailyRevenue: revenue,
      statusDistribution:
        status && typeof status === 'object' && status.distribution
          ? {
              distribution: status.distribution as Record<string, number>,
              total: this.parseNumber(status.total),
            }
          : null,
      topCouriers: topCouriers === null ? null : couriersRanking.items,
      topCouriersMeta: couriersRanking.meta,
    };
  }

  async getRevenueStats(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    // (XdKajqLe) `all=true` — «Barchasi» (366 kunlik chegara, meta bilan).
    const normalized = this.kpiRange(filter);
    const isAllTime = normalized.all === true;
    const period = this.normalizeRevenuePeriod(filter.period);
    const failedParts: string[] = [];

    const [revenue, financialBalance, branchesResponse] = await Promise.all([
      this.readPart(
        this.orderClient,
        'order.analytics.revenue',
        { ...normalized, period },
        failedParts,
        'revenue',
      ),
      this.readPart(
        this.financeClient,
        'finance.cashbox.financial_balance',
        {},
        failedParts,
        'finance',
      ),
      this.readPart(
        this.branchClient,
        'branch.find_all',
        {
          requester,
          query: {
            status: 'active',
            page: 1,
            limit: 1000,
          },
        },
        failedParts,
        'branches',
      ),
    ]);
    this.requirePart(revenue, 'revenue');

    const revenueData = this.unwrapRevenue(revenue);
    const branchReceivable = this.extractBranchReceivable(branchesResponse);
    const financeData = this.applyBranchReceivableToFinancialBalance(
      this.unwrap(financialBalance as any),
      branchReceivable,
    );
    const labels = revenueData.data.map((row) => row.label ?? row.period);
    const values = revenueData.data.map((row) => this.parseNumber(row.revenue));
    // (l9NNdsCH) «Sof foyda» trendi — har bandda `profit` (order-service).
    const profitValues = revenueData.data.map((row) =>
      this.parseNumber(row.profit),
    );
    // `unwrap` bu yerda ishlatilmaydi: xom `{data: [], summary,
    // applied_range}` da u bandlar massivini qaytarib meta'ni yo'qotadi.
    const revenueRoot =
      revenue && typeof revenue === 'object' && 'applied_range' in revenue
        ? revenue
        : (revenue as { data?: unknown } | null)?.data;
    const allTime = isAllTime ? this.allTimeRangeMeta(revenueRoot) : null;

    return successRes(
      {
        data: revenueData.data,
        summary: revenueData.summary,
        chart: { labels, values, profitValues },
        finance: financeData,
        degraded: failedParts.length > 0,
        failed_parts: failedParts.sort(),
        ...(allTime?.meta ?? {}),
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
    // (XdKajqLe) `all=true` — «Barchasi»: barcha bo'laklar (overview,
    // kuryerlar, top marketlar, yetkazish) order-service'ga `all: true`
    // bilan — dashboard bilan AYNI 366 kunlik oyna.
    const normalized = this.kpiRange(filter);
    const isAllTime = normalized.all === true;
    const rangeMs =
      new Date(normalized.endDate).getTime() -
      new Date(normalized.startDate).getTime();
    const revenuePeriod: RevenuePeriod = isAllTime
      ? 'monthly'
      : rangeMs > 5 * 365 * 24 * 60 * 60 * 1000
        ? 'yearly'
        : rangeMs > 90 * 24 * 60 * 60 * 1000
          ? 'monthly'
          : 'daily';
    const failedParts: string[] = [];
    // (mKS1mjNr) Order-service'ga 5 ta chaqiruv, hammasi PARALLEL (bitta
    // 2,5 s bosqich). Ilgari yetkazish vaqti uchun sotilgan buyurtmalar
    // 4 status × 200 talik sahifalab (100 sahifagacha) tortilardi.
    const [overview, revenue, courierStats, topMarkets, fulfillment] =
      await Promise.all([
        this.readPart(
          this.orderClient,
          'order.analytics.overview',
          normalized,
          failedParts,
          'overview',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.revenue',
          { ...normalized, period: revenuePeriod },
          failedParts,
          'revenue',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.courier_stats',
          normalized,
          failedParts,
          'couriers',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_markets',
          { limit: 10, ...normalized, include_meta: true },
          failedParts,
          'topMarkets',
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.fulfillment_stats',
          normalized,
          failedParts,
          'fulfillment',
        ),
      ]);
    this.requirePart(overview, 'overview');

    // (mKS1mjNr) SQL agregat (`getFulfillmentStats`); qiymatlar SATR kelishi
    // mumkin — parseNumber. Formulalar eski JS hisobi bilan AYNAN bir xil.
    const fulfillmentData = this.unwrap<any>(fulfillment as any);
    const deliveryCount = this.parseNumber(fulfillmentData?.deliveredCount);
    const deliveryMsTotal = this.parseNumber(fulfillmentData?.deliveryMsTotal);
    const onTimeCount = this.parseNumber(fulfillmentData?.onTimeCount);

    const overviewData = this.unwrap<any>(overview as any);
    const kpiAllTime = isAllTime ? this.allTimeRangeMeta(overviewData) : null;
    const revenueData = this.unwrapRevenue(revenue);
    const courierStatsData = Array.isArray(
      this.unwrap<any>(courierStats as any),
    )
      ? (this.unwrap<any>(courierStats as any) as any[])
      : [];
    const topMarketsData = this.ranking(topMarkets).items;

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
        // (yrLt5oMi) SLA maxraji: davrda yetkazilgan (sotilgan) buyurtmalar
        // soni. 0 bo'lsa `onTimeRate`/`averageFulfillmentHours` dagi 0 —
        // "o'lchanmagan" (yetkazish yo'q), «0% · past» EMAS. Minimal variant:
        // `onTimeRate` raqamligicha qoladi (eski FE buzilmaydi), FE
        // `deliveryCount === 0` da «O'lchanmagan» chizadi.
        deliveryCount,
        cancellationRate,
        courierEfficiency,
        marketRating: topMarketsData,
        marketRatingMeta: this.ranking(topMarkets).meta,
        degraded: failedParts.length > 0,
        failed_parts: failedParts.sort(),
        ...(kpiAllTime?.meta ?? {}),
      },
      200,
      kpiAllTime
        ? kpiAllTime.message.replace('Dashboard infos', 'KPI stats')
        : 'KPI stats',
    );
  }

  async getOrderReport(
    requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    this.assertFinancialAccess(requester);
    const normalized = this.normalizeDateRangeAny(filter);
    const failedParts: string[] = [];
    /**
     * (W20LoskP) Order-service'ga JAMI 5 ta chaqiruv, hammasi PARALLEL
     * (bitta bosqich, `REPORT_READ_OPTIONS` < gateway `timeout(12000)`).
     *
     * ⚠️ ILGARI viloyat va top mahsulotlar uchun davrdagi barcha buyurtmalar
     * `order.find_all` bilan sahifalab tortilardi (`collectOrders`: 100
     * sahifa × 100 = eng ko'pi 10 000 qator, 100 ta ketma-ket RMQ) — undan
     * katta davrda natija JIM kesilardi. Status taqsimoti esa 9 ta qo'lda
     * yozilgan status bo'yicha 9 ta alohida chaqiruv edi (CREATED, WAITING,
     * WAITING_CUSTOMER, RETURNED_TO_MARKET umuman yo'q edi). Endi uchalasi
     * order-service'da SQL GROUP BY — to'liq, kesilmaydi.
     */
    const [overview, topMarkets, statusRes, regionRes, productRes] =
      await Promise.all([
        this.readPart(
          this.orderClient,
          'order.analytics.overview',
          normalized,
          failedParts,
          'overview',
          REPORT_READ_OPTIONS,
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_markets',
          { limit: 10, ...normalized, include_meta: true },
          failedParts,
          'topMarkets',
          REPORT_READ_OPTIONS,
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.status_distribution',
          normalized,
          failedParts,
          'statusDistribution',
          REPORT_READ_OPTIONS,
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.by_region',
          normalized,
          failedParts,
          'byRegion',
          REPORT_READ_OPTIONS,
        ),
        this.readPart(
          this.orderClient,
          'order.analytics.top_products',
          { ...normalized, limit: 10 },
          failedParts,
          'topProducts',
          REPORT_READ_OPTIONS,
        ),
      ]);

    // Har bir `Order_status` kaliti javobda bor (0 bo'lsa ham). Bo'lak
    // olinmasa — `null` (nollar bilan "bo'sh" deb ko'rsatilmaydi) va
    // `degraded` / `failed_parts` da ko'rinadi.
    const statusData = this.unwrap<any>(statusRes as any);
    let statusDistribution: Record<string, number> | null = null;
    if (statusRes !== null) {
      statusDistribution = {};
      for (const status of Object.values(Order_status)) {
        statusDistribution[status] = 0;
      }
      const source =
        statusData?.distribution && typeof statusData.distribution === 'object'
          ? (statusData.distribution as Record<string, unknown>)
          : {};
      for (const [status, count] of Object.entries(source)) {
        statusDistribution[status] = this.parseNumber(count);
      }
    }
    const statusDistributionTotal = statusDistribution
      ? Object.values(statusDistribution).reduce((sum, n) => sum + n, 0)
      : null;

    const regionData = this.unwrap<any>(regionRes as any);
    const byRegion = (
      Array.isArray(regionData?.items) ? (regionData.items as any[]) : []
    ).map((row) => ({
      region_id: String(row?.region_id ?? 'unknown'),
      total_orders: this.parseNumber(row?.total_orders),
    }));

    const productData = this.unwrap<any>(productRes as any);
    const topProducts = (
      Array.isArray(productData?.items) ? (productData.items as any[]) : []
    ).map((row) => ({
      product_id: String(row?.product_id ?? 'unknown'),
      total_quantity: this.parseNumber(row?.total_quantity),
    }));

    return successRes(
      {
        range: normalized,
        overview: this.unwrap(overview as any),
        statusDistribution,
        statusDistributionTotal,
        byRegion,
        topMarkets: this.ranking(topMarkets).items,
        topMarketsMeta: this.ranking(topMarkets).meta,
        topProducts,
        // Order-service 366 kunlik oynasi (`clamped`) — status/viloyat/
        // mahsulot kesimlari overview bilan AYNI oynada hisoblanadi.
        applied_range:
          statusData?.applied_range ?? regionData?.applied_range ?? null,
        degraded: failedParts.length > 0,
        failed_parts: failedParts.sort(),
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

    // Cache key intentionally ignores requester — the aggregation is
    // role-independent (we return the same items[]/ranking[]; only the
    // final filter step at the end differs per requester).
    const cacheKey = `${normalized.startDate ?? ''}|${normalized.endDate ?? ''}`;
    const now = Date.now();
    const cached = this.courierReportCache.get(cacheKey);
    let items: any[];
    let topCouriersData: any[];
    let topCouriersMeta: { min_orders: number; filtered_out: number } | null;

    if (cached && cached.expiresAt > now) {
      items = cached.data.items;
      topCouriersData = cached.data.ranking;
      topCouriersMeta = cached.data.rankingMeta ?? null;
    } else {
      /**
       * juZFa64U — N+1 YO'Q: ilgari har kuryer uchun alohida
       * `order.analytics.courier_stat` (bekor qilinganlar, daromad)
       * yuborilardi. Endi `include_detail: true` bilan order-service ularni
       * shu javobning har qatoriga bitta to'plamli SQL'da qo'shadi — RMQ
       * so'rovlari soni kuryerlar soniga bog'liq emas (items — 1, reyting —
       * 1). Qatorda maydon bo'lmasa (eski order-service, deploy oralig'i) —
       * avvalgi zaxira: bekor = jami − sotilgan, daromad 0.
       */
      const [courierStats, topCouriers] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stats' },
          { ...normalized, include_detail: true },
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_couriers' },
          { limit: 20, ...normalized, include_meta: true },
        ),
      ]);

      const courierStatsData = Array.isArray(
        this.unwrap<any>(courierStats as any),
      )
        ? (this.unwrap<any>(courierStats as any) as any[])
        : [];
      topCouriersData = this.ranking(topCouriers).items;
      topCouriersMeta = this.ranking(topCouriers).meta;

      items = courierStatsData.map((row) => ({
        // CODE-08: identity'ning to'liq kuryer qatori (telefon, maosh,
        // tariflar) emas — faqat {id, name}.
        courier: this.toPartyRef(row?.courier),
        deliveredOrders: this.parseNumber(row?.soldOrders),
        cancelledOrders: this.parseNumber(
          row?.canceledOrders,
          Math.max(
            0,
            this.parseNumber(row?.totalOrders) -
              this.parseNumber(row?.soldOrders),
          ),
        ),
        averageDeliveryHours: null,
        totalAmount: this.parseNumber(row?.profit),
        salaryEstimate: this.parseNumber(row?.profit),
        successRate: this.parseNumber(row?.successRate),
      }));

      // Opportunistic eviction to keep the map bounded.
      for (const [key, entry] of this.courierReportCache.entries()) {
        if (entry.expiresAt <= now) {
          this.courierReportCache.delete(key);
        }
      }

      this.courierReportCache.set(cacheKey, {
        data: { items, ranking: topCouriersData, rankingMeta: topCouriersMeta },
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
          rankingMeta: topCouriersMeta,
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
          rankingMeta: topCouriersMeta,
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
        rankingMeta: topCouriersMeta,
      },
      200,
      'Courier report',
    );
  }
}
