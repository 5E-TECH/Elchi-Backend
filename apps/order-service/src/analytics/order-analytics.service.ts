import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import { BranchType, Order_status, Roles, rmqSend } from '@app/common';
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
  /**
   * Analitika so'rovining eng katta oynasi (audit C3).
   *
   * ⚠️ 768 KUN AMALDA CHEGARA EMAS EDI. Kuniga 1 000 buyurtmada bu ~770 ming
   * qatorni JS xotirasiga yuklash degani — servis xotira shifti 1,5 GB, ya'ni
   * dashboard OOM bilan yiqilardi. 180 kun (yarim yil) real hisobotlar uchun
   * yetarli, undan uzoq davrni esa `sold_at` bo'yicha SQL agregatsiyasi bilan
   * alohida qilish kerak.
   */
  private static readonly MAX_ANALYTICS_SPAN_MS = 180 * 24 * 60 * 60 * 1000;

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

  /**
   * Sotuv foydasining SQL ifodasi — `sell_profit` daftaridagi formulaning
   * AYNI O'ZI (`computeSellProfit`): market tarifi minus kuryer ulushi minus
   * hamkor filial ulushi. Barcha qiymatlar buyurtmada sotuv paytida
   * qotirilgan, ya'ni tarif keyin o'zgarsa ham eski hisobot o'zgarmaydi.
   *
   * `courier_share` yo'q eski qatorlarda `courier_tariff` ga tushiladi —
   * sotuv yo'lidagi fallback bilan bir xil.
   */
  private static readonly PROFIT_SQL =
    'COALESCE(SUM(' +
    'COALESCE(o.market_tariff, 0) ' +
    '- COALESCE(o.courier_share, o.courier_tariff, 0) ' +
    '- COALESCE(o.branch_share, 0)' +
    '), 0)';

  /**
   * `sold_at` (epoch ms, bigint) ni TOSHKENT kunining boshiga keltiradigan
   * SQL ifodasi.
   *
   * ⚠️ ILGARI BU YERDA KUN SURILIB KETARDI. Oyna chegaralari Toshkent
   * vaqtida hisoblanardi (`analyticsDateRange`), kalitlar `dateKey` orqali
   * Toshkentda formatlanardi, LEKIN `periodStart` kunni SERVER vaqtida
   * (konteynerda UTC) kesardi. Natijada Toshkent bo'yicha ertalab soat 5 dan
   * oldin sotilgan buyurtma oldingi kun bandiga tushardi — "qo'shaloq
   * pattern" deb ataladigan klassik xato. Endi kesish ham, formatlash ham
   * bitta mintaqada.
   */
  private tashkentPeriodKeySql(
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): string {
    const local =
      "(to_timestamp(o.sold_at::bigint / 1000) AT TIME ZONE 'Asia/Tashkent')";
    if (period === 'daily') {
      return `to_char(date_trunc('day', ${local}), 'YYYY-MM-DD')`;
    }
    if (period === 'weekly') {
      return `'W:' || to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
    }
    if (period === 'monthly') {
      return `'M:' || to_char(date_trunc('month', ${local}), 'YYYY-MM')`;
    }
    return `'Y:' || to_char(date_trunc('year', ${local}), 'YYYY')`;
  }

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

  /**
   * Analitika oynasini hal qiladi. `all=true` — "butun davr" tugmasi, lekin u
   * CHEGARANI CHETLAB O'TMAYDI (audit C3): ilgari `all` berilganda oyna
   * umuman qo'yilmasdi va so'rov butun `orders` jadvalini JS xotirasiga
   * yuklardi. Endi u eng katta ruxsat etilgan oynaga (`MAX_ANALYTICS_SPAN_MS`)
   * teng, bugungi kun bilan tugaydigan davrni beradi va qisqartirish jurnalga
   * yoziladi — ya'ni raqam "butun davr" emasligi ko'rinadi.
   */
  private resolveAnalyticsRange(
    startDate: string | undefined,
    endDate: string | undefined,
    all: boolean,
  ): { start: Date; end: Date } {
    if (!all) {
      return this.analyticsDateRange(startDate, endDate);
    }
    const end = new Date();
    const start = new Date(
      end.getTime() - OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS,
    );
    this.logger.warn(
      `Analytics 'all' requested; clamped to the last ` +
        `${Math.round(
          OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS / 86_400_000,
        )} days (${start.toISOString()} → ${end.toISOString()})`,
    );
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

  private async countDashboardAcceptedOrders(
    range: { start: Date; end: Date } | null,
    branchId?: string,
  ) {
    const query = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false }),
      branchId,
    ).select('COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))', 'count');

    if (range) {
      query.andWhere('o.createdAt BETWEEN :start AND :end', range);
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

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich).
   *
   * Ilgari bu metod oynadagi HAR BIR sotilgan buyurtmani JS xotirasiga
   * yuklab (`getMany()`), so'ng ustidan sikl yurgizardi — kuniga 2 000
   * buyurtmada 180 kunlik oyna ~360 ming qator, 5 000 da esa ~900 ming.
   * Servis xotira shifti 1,5 GB, ya'ni bu yo'l hajm o'sishi bilan avval
   * sekinlashib, keyin yiqilardi. Ustiga har safar market/pochta/kuryer
   * ro'yxatlari uchun uchta RMQ chaqiruvi ketardi.
   *
   * Endi bitta SQL qatori qaytadi: qancha buyurtma bo'lsa ham xotira
   * o'zgarmaydi.
   *
   * ⚠️ FOYDA ENDI SNAPSHOTDAN. Ilgari u LIVE tariflardan hisoblanardi
   * (market profili − kuryer profili), ya'ni tarif keyin o'zgarsa eski
   * hisobot ham o'zgarib ketardi va raqam `sell_profit` daftaridagi bilan
   * MOS KELMASDI. Endi buyurtmada sotuv paytida qotirilgan qiymatlar
   * ishlatiladi — aynan daftardagi formulaning o'zi
   * (`market_tariff − courier_share − branch_share`).
   */
  /**
   * Filial paneli uchun barcha raqamlar — BITTA joyda, bazada hisoblanadi
   * (Scale 1-bosqich).
   *
   * ⚠️ NEGA. branch-service bu raqamlarni har filial uchun `order.find_all`
   * ni `fetch_all` bilan chaqirib (filial boshiga 5 000 tagacha buyurtma,
   * mahsulotlari bilan) RabbitMQ orqali tortib olib, JS'da sanardi. Uch
   * oqibati bor edi: ~3 MB/filial tarmoq trafigi, order-service event
   * loop'ining band bo'lishi (ya'ni sotuv kechikishi), va 5 000 dan oshganda
   * statistikaning jimgina kam ko'rsatishi.
   *
   * Endi tashiladigan narsa — bir necha o'nlab qator: hisoblar va market
   * kesimi.
   */
  async getBranchDashboardStats(input: {
    branch_ids?: string[];
    courier_ids?: string[];
    start?: string | null;
    end?: string | null;
    today_start: string;
    week_start: string;
  }) {
    const branchIds = (input?.branch_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    const courierIds = (input?.courier_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);

    if (!branchIds.length && !courierIds.length) {
      return this.emptyBranchDashboardStats();
    }

    const scoped = () => this.branchScopedQuery(branchIds, courierIds);
    const now = new Date();
    const todayStart = new Date(input.today_start);
    const weekStart = new Date(input.week_start);
    const rangeStart = input.start ? new Date(input.start) : null;
    const rangeEnd = input.end ? new Date(input.end) : now;

    const inRange = () => {
      const qb = scoped();
      if (rangeStart) {
        qb.andWhere('o.createdAt BETWEEN :rangeStart AND :rangeEnd', {
          rangeStart,
          rangeEnd,
        });
      }
      return qb;
    };

    const activeBatchStatuses = [
      Order_status.CREATED,
      Order_status.NEW,
      Order_status.RECEIVED,
      Order_status.ON_THE_ROAD,
      Order_status.WAITING,
      Order_status.WAITING_CUSTOMER,
      Order_status.PARTLY_PAID,
    ];
    const deliveredStatuses = this.soldStatuses();

    const [
      todayCount,
      weekCount,
      selectedCount,
      activeBatches,
      statusRows,
      marketRows,
      packageRows,
      activeCouriers,
    ] = await Promise.all([
      scoped()
        .andWhere('o.createdAt BETWEEN :todayStart AND :now', {
          todayStart,
          now,
        })
        .getCount(),
      scoped()
        .andWhere('o.createdAt BETWEEN :weekStart AND :now', { weekStart, now })
        .getCount(),
      inRange().getCount(),
      scoped()
        .andWhere('o.current_batch_id IS NOT NULL')
        .andWhere('o.status IN (:...statuses)', {
          statuses: activeBatchStatuses,
        })
        .select('COUNT(DISTINCT o.current_batch_id)', 'count')
        .getRawOne<{ count: string }>(),
      inRange()
        .select('o.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('o.status')
        .getRawMany<{ status: string; count: string }>(),
      inRange()
        .andWhere('o.market_id IS NOT NULL')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'orders_count')
        .addSelect('COALESCE(SUM(o.total_price), 0)', 'total_price')
        .addSelect(
          'SUM(CASE WHEN o.status IN (:...delivered) THEN 1 ELSE 0 END)',
          'delivered_count',
        )
        .setParameter('delivered', deliveredStatuses)
        .groupBy('o.market_id')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany<{
          market_id: string;
          orders_count: string;
          total_price: string;
          delivered_count: string;
        }>(),
      inRange()
        .andWhere('o.current_batch_id IS NOT NULL')
        .andWhere('o.status IN (:...statuses)', {
          statuses: [Order_status.ON_THE_ROAD, Order_status.RECEIVED],
        })
        .select('o.status', 'status')
        .addSelect('COUNT(DISTINCT o.current_batch_id)', 'count')
        .groupBy('o.status')
        .getRawMany<{ status: string; count: string }>(),
      inRange()
        .andWhere('o.courier_id IS NOT NULL')
        .select('COUNT(DISTINCT o.courier_id)', 'count')
        .getRawOne<{ count: string }>(),
    ]);

    const countOf = (statuses: string[]): number =>
      statusRows
        .filter((row) => statuses.includes(String(row.status)))
        .reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    const packagesOf = (status: string): number =>
      packageRows
        .filter((row) => String(row.status) === status)
        .reduce((sum, row) => sum + (Number(row.count) || 0), 0);

    return {
      today_orders_count: todayCount,
      week_orders_count: weekCount,
      selected_orders_count: selectedCount,
      active_batches_count: Number(activeBatches?.count ?? 0),
      orders_card: {
        total: selectedCount,
        new: countOf([Order_status.NEW]),
        on_the_road: countOf([Order_status.ON_THE_ROAD]),
        delivered: countOf(deliveredStatuses),
        returned: countOf([Order_status.RETURNED_TO_MARKET]),
      },
      markets: marketRows.map((row) => ({
        market_id: String(row.market_id),
        orders_count: Number(row.orders_count) || 0,
        delivered_count: Number(row.delivered_count) || 0,
        total_price: Number(row.total_price) || 0,
      })),
      packages: {
        on_the_way: packagesOf(Order_status.ON_THE_ROAD),
        waiting_for_acceptance: packagesOf(Order_status.RECEIVED),
      },
      active_couriers: Number(activeCouriers?.count ?? 0),
    };
  }

  /** Filial(lar) bo'yicha status kesimidagi hisob — bitta so'rovda. */
  async countOrdersByBranch(input: { branch_ids?: string[]; status?: string }) {
    const branchIds = (input?.branch_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    if (!branchIds.length) {
      return [];
    }

    const branchExpression =
      'COALESCE(o.home_branch_id, o.branch_id, o.holder_branch_id)';
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere(`${branchExpression} IN (:...branchIds)`, { branchIds })
      .select(branchExpression, 'branch_id')
      .addSelect('COUNT(*)', 'count')
      .groupBy(branchExpression);

    if (input?.status) {
      qb.andWhere('o.status = :status', { status: input.status });
    }

    const rows = await qb.getRawMany<{ branch_id: string; count: string }>();
    return rows.map((row) => ({
      branch_id: String(row.branch_id),
      count: Number(row.count) || 0,
    }));
  }

  /**
   * Filial + uning kuryerlari doirasidagi buyurtmalar uchun bazaviy so'rov.
   * `getOrdersByBranchIds` ning SQL ekvivalenti: ilgari u ikki alohida
   * chaqiruv qilib, natijalarni JS'da birlashtirardi.
   */
  private branchScopedQuery(branchIds: string[], courierIds: string[]) {
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false });

    const conditions: string[] = [];
    if (branchIds.length) {
      conditions.push(
        '(o.branch_id IN (:...branchIds) OR o.holder_branch_id IN (:...branchIds) OR o.home_branch_id IN (:...branchIds))',
      );
    }
    if (courierIds.length) {
      conditions.push(
        '(o.courier_id IN (:...courierIds) OR o.holder_courier_id IN (:...courierIds))',
      );
    }
    qb.andWhere(`(${conditions.join(' OR ')})`, { branchIds, courierIds });
    return qb;
  }

  private emptyBranchDashboardStats() {
    return {
      today_orders_count: 0,
      week_orders_count: 0,
      selected_orders_count: 0,
      active_batches_count: 0,
      orders_card: {
        total: 0,
        new: 0,
        on_the_road: 0,
        delivered: 0,
        returned: 0,
      },
      markets: [] as Array<{
        market_id: string;
        orders_count: number;
        delivered_count: number;
        total_price: number;
      }>,
      packages: { on_the_way: 0, waiting_for_acceptance: 0 },
      active_couriers: 0,
    };
  }

  async getOverviewStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    all = false,
  ) {
    const range = this.resolveAnalyticsRange(startDate, endDate, all);
    const soldStatuses = this.soldStatuses();

    const soldAggregateQuery = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      branchId,
    )
      .select('COUNT(*)', 'sold_count')
      .addSelect('COALESCE(SUM(o.total_price), 0)', 'revenue')
      .addSelect(OrderAnalyticsService.PROFIT_SQL, 'profit');

    if (range) {
      soldAggregateQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs: String(range.start.getTime()),
        endMs: String(range.end.getTime()),
      });
    }

    const [acceptedCount, cancelled, aggregate] = await Promise.all([
      this.countDashboardAcceptedOrders(range, branchId),
      this.countHistoricallyCancelledOrders(range, branchId),
      soldAggregateQuery.getRawOne<{
        sold_count: string;
        revenue: string;
        profit: string;
      }>(),
    ]);

    return {
      acceptedCount,
      total: acceptedCount,
      totalOrders: acceptedCount,
      ordersCount: acceptedCount,
      cancelled,
      soldAndPaid: Number(aggregate?.sold_count ?? 0),
      profit: Number(aggregate?.profit ?? 0),
      totalRevenue: Number(aggregate?.revenue ?? 0),
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

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich). Ilgari oynadagi barcha
   * buyurtmalar yuklanib, kuryerga tegishliligi JS'da hisoblanardi. Endi SQL
   * `GROUP BY post_id` qaytaradi — natija qatorlari soni POCHTALAR soniga
   * teng (kuryer × kun), buyurtmalar soniga emas. 180 kunlik oynada bu
   * o'nlab ming emas, bir necha ming qator.
   */
  async getCourierStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
          { start, end },
        )
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .select('o.post_id', 'post_id')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN o.status IN (:...statuses) ' +
          'AND o.sold_at BETWEEN :startMs AND :endMs THEN 1 ELSE 0 END)',
        'sold',
      )
      .setParameters({ statuses: soldStatuses, startMs, endMs })
      .groupBy('o.post_id')
      .getRawMany<{ post_id: string; total: string; sold: string }>();

    if (!rows.length) {
      return [];
    }

    const posts = await this.getPostsByIds(
      rows.map((row) => String(row.post_id)),
    );
    const postMap = new Map(posts.map((post) => [String(post.id), post]));
    const courierIds = [
      ...new Set(
        posts.map((post) => post.courier_id).filter(Boolean) as string[],
      ),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);

    const statsByCourier = new Map<string, { total: number; sold: number }>();
    for (const row of rows) {
      const courierId = postMap.get(String(row.post_id))?.courier_id;
      if (!courierId) continue;
      const current = statsByCourier.get(String(courierId)) ?? {
        total: 0,
        sold: 0,
      };
      current.total += Number(row.total) || 0;
      current.sold += Number(row.sold) || 0;
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

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich). Ilgari oxirgi 30 kunning BARCHA
   * buyurtmalari yuklanib JS'da sanalardi. Endi `GROUP BY post_id`.
   */
  async getTopCouriers(limit = 10, branchId?: string) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :lastMonth', { lastMonth })
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .select('o.post_id', 'post_id')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)',
        'successful',
      )
      .setParameter('statuses', soldStatuses)
      .groupBy('o.post_id')
      .getRawMany<{ post_id: string; total: string; successful: string }>();

    if (!rows.length) {
      return [];
    }

    const posts = await this.getPostsByIds(
      rows.map((row) => String(row.post_id)),
    );
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierIds = [
      ...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[]),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    const stats = new Map<string, { total: number; successful: number }>();
    for (const row of rows) {
      const courierId = postMap.get(String(row.post_id))?.courier_id;
      if (!courierId) continue;
      const current = stats.get(String(courierId)) ?? {
        total: 0,
        successful: 0,
      };
      current.total += Number(row.total) || 0;
      current.successful += Number(row.successful) || 0;
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

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich) + FOYDA SNAPSHOTDAN.
   *
   * Ilgari sotilgan buyurtmalar yuklanib, har biriga kuryerning LIVE tarifi
   * qo'shilardi — ya'ni kuryer tarifi keyin o'zgarsa, eski hisobot ham
   * o'zgarib ketardi. Endi buyurtmada qotirilgan `courier_share` (kuryer
   * HAQIQATAN olib qolgan summa; oylik kuryerda 0) yig'iladi.
   */
  async getCourierStat(
    courierId: string,
    startDate?: string,
    endDate?: string,
    all = false,
  ) {
    const range = this.resolveAnalyticsRange(startDate, endDate, all);
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
    const soldAggregateQuery = this.applyAnalyticsCourierScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      courierId,
      postIds,
    )
      .select('COUNT(*)', 'sold_count')
      .addSelect(
        'COALESCE(SUM(COALESCE(o.courier_share, o.courier_tariff, 0)), 0)',
        'profit',
      );

    if (range) {
      totalOrdersQuery.andWhere(
        'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
        range,
      );
      soldAggregateQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs: String(range.start.getTime()),
        endMs: String(range.end.getTime()),
      });
    }

    const [totalOrders, canceledOrders, aggregate] = await Promise.all([
      totalOrdersQuery.getCount(),
      this.countHistoricallyCancelledOrders(
        range,
        undefined,
        courierId,
        postIds,
      ),
      soldAggregateQuery.getRawOne<{ sold_count: string; profit: string }>(),
    ]);

    const soldOrders = Number(aggregate?.sold_count ?? 0);
    const profit = Number(aggregate?.profit ?? 0);
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

  /**
   * ⚠️ "ID RO'YXATI" NAQSHI OLIB TASHLANDI (Scale 1-bosqich).
   *
   * Ilgari bu metod avval oynadagi BARCHA buyurtma id'larini yuklab olardi,
   * so'ng to'rtta hisobni `id IN (:...orderIds)` bilan cheklardi. Ikki
   * oqibati bor edi: (1) id'lar JS xotirasiga yuklanardi; (2) faol market
   * uchun `IN` ro'yxati o'n minglab elementga chiqib, so'rovning o'zi
   * Postgres uchun og'ir (yoki umuman bajarilmas) bo'lib qolardi.
   *
   * Filtrlar endi to'g'ridan-to'g'ri har bir hisobga qo'yiladi — natija
   * bir xil, lekin xotira ham, so'rov hajmi ham o'zgarmas.
   */
  async getMarketStat(marketId: string, startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const base = () =>
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.market_id = :marketId', { marketId });

    const inRange = () =>
      base().andWhere('o.createdAt BETWEEN :start AND :end', { start, end });

    const [totalOrders, canceledOrders, inProgress, soldAggregate] =
      await Promise.all([
        inRange().getCount(),
        inRange()
          .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
          .andWhere('o.status IN (:...statuses)', {
            statuses: this.cancelledMarketStatuses(),
          })
          .getCount(),
        inRange()
          .andWhere('o.status IN (:...statuses)', {
            statuses: this.activeMarketStatuses(),
          })
          .getCount(),
        inRange()
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
            startMs,
            endMs,
          })
          .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
          .select('COUNT(*)', 'sold_count')
          .addSelect('COALESCE(SUM(o.to_be_paid), 0)', 'profit')
          .getRawOne<{ sold_count: string; profit: string }>(),
      ]);

    const soldOrders = Number(soldAggregate?.sold_count ?? 0);
    const successRate =
      totalOrders > 0
        ? Number(((soldOrders * 100) / totalOrders).toFixed(2))
        : 0;

    return {
      totalOrders,
      soldOrders,
      canceledOrders,
      inProgress,
      profit: Number(soldAggregate?.profit ?? 0),
      successRate,
    };
  }

  /**
   * ⚠️ BANDLARGA BO'LISH BAZADA (Scale 1-bosqich) + KUN SURILISHI TUZATILDI.
   *
   * Ilgari oynadagi barcha sotuvlar yuklanib, JS'da kun/hafta/oy bandlariga
   * taqsimlanardi. Endi `GROUP BY` bazada, natija — bandlar soni (kunlik
   * oynada ko'pi bilan 180 qator).
   *
   * Kun chegarasi ham tuzatildi: kalitlar `dateKey` orqali TOSHKENT vaqtida
   * formatlanardi, lekin kun `periodStart` da SERVER vaqtida (konteynerda
   * UTC) kesilardi — ya'ni Toshkent bo'yicha ertalab 05:00 dan oldin
   * sotilgan buyurtma oldingi kun bandiga tushardi. Endi ikkalasi ham
   * `Asia/Tashkent` da.
   */
  async getRevenueStats(
    startDate?: string,
    endDate?: string,
    period = 'daily',
  ) {
    const normalizedPeriod = this.normalizeRevenuePeriod(period);
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const keySql = this.tashkentPeriodKeySql(normalizedPeriod);

    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs: String(start.getTime()),
        endMs: String(end.getTime()),
      })
      .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
      .select(keySql, 'period_key')
      .addSelect('COUNT(*)', 'orders_count')
      .addSelect('COALESCE(SUM(o.total_price), 0)', 'revenue')
      .groupBy(keySql)
      .getRawMany<{
        period_key: string;
        orders_count: string;
        revenue: string;
      }>();

    const byKey = new Map(rows.map((row) => [String(row.period_key), row]));

    // Bo'sh bandlar ham qaytishi kerak (grafik uzilmasligi uchun), shuning
    // uchun skelet oldingidek JS'da quriladi — u faqat sanalar ustida
    // yuradi, buyurtmalar ustida emas.
    const buckets: Array<{
      period: string;
      label: string;
      ordersCount: number;
      revenue: number;
    }> = [];
    let cursor = this.periodStart(start, normalizedPeriod);
    const endCursor = this.periodStart(end, normalizedPeriod);
    while (cursor <= endCursor) {
      const key = this.periodKey(cursor, normalizedPeriod);
      const row = byKey.get(key);
      buckets.push({
        period: key,
        label: this.periodLabel(cursor, normalizedPeriod),
        ordersCount: Number(row?.orders_count ?? 0),
        revenue: Number(row?.revenue ?? 0),
      });
      cursor = this.nextPeriodStart(cursor, normalizedPeriod);
    }

    // Skeletga tushmay qolgan bandlar (chegara holatlari) ham yo'qolmasin.
    const known = new Set(buckets.map((bucket) => bucket.period));
    for (const row of rows) {
      const key = String(row.period_key);
      if (known.has(key)) continue;
      buckets.push({
        period: key,
        label: key,
        ordersCount: Number(row.orders_count ?? 0),
        revenue: Number(row.revenue ?? 0),
      });
    }
    buckets.sort((a, b) => a.period.localeCompare(b.period));

    const totalRevenue = buckets.reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = buckets.reduce((sum, row) => sum + row.ordersCount, 0);
    const avgRevenue = buckets.length
      ? Math.round(totalRevenue / buckets.length)
      : 0;

    return {
      data: buckets,
      summary: {
        totalRevenue,
        totalOrders,
        avgRevenue,
      },
    };
  }
}
