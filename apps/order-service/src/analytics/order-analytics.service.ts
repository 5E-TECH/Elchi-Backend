import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import {
  BranchType,
  CancelReason,
  Order_status,
  Roles,
  rmqSend,
} from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderLookupService } from '../lookup/order-lookup.service';
import {
  CANCEL_REASON_UNKNOWN,
  CANCEL_REASON_UNKNOWN_UZ,
  CANCEL_REASON_UZ,
} from '../domain/cancel-reason';

/**
 * PUvKXWVw — hisobot sanasi TOSHKENT kuni chegarasida (`analyticsDateRange`
 * dagi `parseUzDate` bilan bir xil qoida, oyna qisqartirilmaydi):
 *   • bo'sh — `null` (chegara yo'q);
 *   • faqat raqam — epoch ms;
 *   • `T` bor (vaqt/zonasi aniq) — o'zicha;
 *   • `YYYY-MM-DD` — Toshkent kunining boshi (00:00:00.000) yoki oxiri
 *     (23:59:59.999), ya'ni UTC'da −5 soat.
 * Yaroqsiz qiymat — 400.
 */
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
export function parseTashkentBoundary(
  value: string | undefined | null,
  endOfDay: boolean,
): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  let date: Date;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (/^\d+$/.test(raw)) {
    date = new Date(Number(raw));
  } else if (raw.includes('T')) {
    date = new Date(raw);
  } else if (day) {
    const [, year, month, dayOfMonth] = day.map(Number);
    const utcMs = Date.UTC(
      year,
      month - 1,
      dayOfMonth,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
    date = new Date(utcMs - TASHKENT_OFFSET_MS);
    // 2026-02-30 kabi yo'q kun — Date.UTC uni keyingi oyga suradi.
    const wall = new Date(date.getTime() + TASHKENT_OFFSET_MS);
    if (wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== dayOfMonth) {
      date = new Date(Number.NaN);
    }
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) {
    throw new RpcException({
      statusCode: 400,
      message: `Sana noto'g'ri formatda: ${raw}`,
    });
  }
  return date;
}

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
   * dashboard OOM bilan yiqilardi. Hozir asosiy kesimlar SQL agregatsiyada;
   * 366 kun to'liq kalendar yilni qamrab oladi, undan keng davr esa kesiladi.
   */
  private static readonly MAX_ANALYTICS_SPAN_DAYS = 366;
  private static readonly MAX_ANALYTICS_SPAN_MS =
    OrderAnalyticsService.MAX_ANALYTICS_SPAN_DAYS * 24 * 60 * 60 * 1000;

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

  private ceilToTashkentDayStart(date: Date): Date {
    const dayStart = this.periodStart(date, 'daily');
    return dayStart.getTime() === date.getTime()
      ? dayStart
      : new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  }

  /**
   * Analitika oynasi + javob uchun `applied_range`.
   *
   * (uN1tjjGu) `all=true` ("Barchasi") CHEGARANI CHETLAB O'TMAYDI (audit C3,
   * wt8 o'lchovi): u 1970-01-01 → `endDate` (yo'q bo'lsa hozir) deb so'raladi
   * va boshqa keng oraliqlar kabi eng so'nggi `MAX_ANALYTICS_SPAN_DAYS` kunga
   * qisqartiriladi. Ilgari (4dfb0ec) `all` oynani butunlay ochib yuborardi —
   * tarix uzaygan sari dashboard 2,5 s lik analitika byudjetidan (VkwhHqvW)
   * chiqib 503 berardi, `getCourierStats`/`getTopCouriers` ning pochta id
   * ro'yxati esa Postgres'ning 65 535 parametr chegarasiga urilib kuryerlarni
   * JIM bo'sh qaytarardi. Qisqartirish jim emas: `applied_range.clamped` va
   * `requested_*: null` ("butun davr" so'ralgan) javobda ko'rinadi.
   * Haqiqiy butun davr uchun oldindan yig'ilgan (kunlik rollup) jadval kerak.
   */
  private analyticsDateRange(
    startDate?: string,
    endDate?: string,
    all = false,
  ) {
    if (all) {
      startDate = '1970-01-01';
      endDate =
        endDate && String(endDate).trim().length > 0
          ? endDate
          : new Date().toISOString();
    }
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
    const requestedStart = start;
    const requestedEnd = end;
    const span = end.getTime() - start.getTime();
    if (span > OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS) {
      const clampedStart = this.ceilToTashkentDayStart(
        new Date(end.getTime() - OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS),
      );
      this.logger.warn(
        `Analytics date span ${Math.round(span / 86_400_000)}d exceeds cap ` +
          `${Math.round(OrderAnalyticsService.MAX_ANALYTICS_SPAN_MS / 86_400_000)}d; ` +
          `clamping start ${start.toISOString()} -> ${clampedStart.toISOString()}`,
      );
      start = clampedStart;
    }

    return {
      start,
      end,
      applied_range: {
        // (uN1tjjGu) `all` — "butun davr" so'ralgan: aniq so'ralgan sana yo'q.
        requested_from: all ? null : requestedStart.toISOString(),
        requested_to: all ? null : requestedEnd.toISOString(),
        applied_from: start.toISOString(),
        applied_to: end.toISOString(),
        clamped: start.getTime() !== requestedStart.getTime(),
        max_span_days: OrderAnalyticsService.MAX_ANALYTICS_SPAN_DAYS,
      },
    };
  }

  /**
   * (uN1tjjGu) `all=true` ham `analyticsDateRange` dagi chegaradan o'tadi —
   * dashboardning barcha bo'laklari (overview, market/kuryer jadvallari,
   * reytinglar) AYNI oynada hisoblanadi.
   */
  private resolveAnalyticsRange(
    startDate: string | undefined,
    endDate: string | undefined,
    all: boolean,
  ) {
    return this.analyticsDateRange(startDate, endDate, all);
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
    const row = await this.historicallyCancelledTrackingQuery(
      range,
      branchId,
      courierId,
      postIds,
    )
      .select('COUNT(DISTINCT t.order_id)', 'count')
      .getRawOne<{ count?: string | number }>();
    return Number(row?.count ?? 0);
  }

  /**
   * (l9NNdsCH) «Yo'qotilgan daromad» — `countHistoricallyCancelledOrders`
   * sanaydigan AYNI bekor buyurtmalar to'plamining `total_price` yig'indisi.
   * Bitta buyurtmada bir nechta bekor o'tishi bo'lishi mumkin (CANCELLED →
   * CANCELLED_SENT → CLOSED), shuning uchun summa buyurtma bo'yicha
   * DISTINCT: `jsonb_object_agg(o.id, …)` takror kalitlarni bittaga
   * yig'adi, so'ng qiymatlar qo'shiladi (agregat argumentlari faqat tashqi
   * so'rov ustunlari — Postgres uni tashqi darajada hisoblaydi). Qator yo'q
   * bo'lsa — 0.
   */
  private static readonly LOST_REVENUE_SQL =
    'COALESCE((SELECT SUM(lost.value::numeric) FROM jsonb_each_text(' +
    'jsonb_object_agg(o.id, COALESCE(o.total_price, 0))) AS lost), 0)';

  private async historicallyCancelledCountAndAmount(
    range: { start: Date; end: Date } | null,
    branchId?: string,
  ): Promise<{ count: number; amount: number }> {
    const row = await this.historicallyCancelledTrackingQuery(range, branchId)
      .select('COUNT(DISTINCT t.order_id)', 'count')
      .addSelect(OrderAnalyticsService.LOST_REVENUE_SQL, 'amount')
      .getRawOne<{ count?: string | number; amount?: string | number }>();
    const amount = Number(row?.amount ?? 0);
    return {
      count: Number(row?.count ?? 0),
      amount: Number.isFinite(amount) ? amount : 0,
    };
  }

  /** Tarixan bekor qilingan buyurtmalar kuzatuv so'rovi (SELECT'siz). */
  private historicallyCancelledTrackingQuery(
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
      // T8: holatsiz yozuv (from = to — masalan bekor buyurtmada maxsus belgi
      // o'zgarishi) qayta bekor deb sanalmaydi.
      // Ikki ustun alohida enum tiplari — matn sifatida solishtiriladi.
      .andWhere('t.from_status::text IS DISTINCT FROM t.to_status::text');

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
      query.andWhere('t.created_at BETWEEN :start AND :end', {
        start: range.start,
        end: range.end,
      });
    }

    return query;
  }

  /**
   * Dashboard «Jami qabul qilingan» — davrda YARATILGAN buyurtma qatorlari.
   *
   * ⚠️ BOLA-BUYURTMA ALOHIDA SANALADI (SqVMuhKo, 2026-10-09 prod testi).
   * Ilgari `COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))` edi: qisman
   * sotuvdan hosil bo'lgan bola (`partlySellOrder` yaratadigan CANCELLED
   * qator, o'z QR'i va qaytarish yo'li bilan) ota bilan bitta sanalardi.
   * Natijada:
   *  - GET /orders (sana filtri) bilan son farq qilardi — 08.10 da ro'yxat
   *    10, dashboard 9; 01–09.10 da 39 vs 37 (#29 → #25, #20 → #17);
   *  - shu javobning o'zidagi `cancelled` bolani ALOHIDA sanaydi (kuzatuvda
   *    CANCELLED), ya'ni «Jarayonda» = jami − sotilgan − bekor bitta kam
   *    chiqardi, sotish + bekor ulushi 100% dan oshardi;
   *  - market jadvali (`getMarketStats`), market/kuryer dashboardi va
   *    hisobotdagi viloyat taqsimoti allaqachon qator sanaydi — markazdagi
   *    son jadval yig'indisidan kam edi (prod, 01–09.10: 29 vs 31);
   *  - ota bir kunda, bola boshqa kunda bo'lsa ota bola kuniga ham
   *    «qabul qilingan» bo'lib tushardi (kunlar yig'indisi davrga teng emas).
   * Endi ro'yxat bilan AYNI qoida: o'chirilmagan, davrda yaratilgan har bir
   * buyurtma qatori.
   */
  private async countDashboardAcceptedOrders(
    range: { start: Date; end: Date } | null,
    branchId?: string,
  ) {
    const query = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false }),
      branchId,
    ).select('COUNT(*)', 'count');

    if (range) {
      query.andWhere('o.createdAt BETWEEN :start AND :end', {
        start: range.start,
        end: range.end,
      });
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

  /**
   * Toshkent vaqti UTC+5, yozgi vaqt YO'Q — shuning uchun "Toshkent devor
   * soati" oddiy siljitish bilan olinadi: lahzaga +5 soat qo'shilgan Date ning
   * UTC maydonlari aynan Toshkentdagi yil/oy/kun/soat.
   */
  private static readonly TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

  private toTashkentWall(date: Date): Date {
    return new Date(date.getTime() + OrderAnalyticsService.TASHKENT_OFFSET_MS);
  }

  private fromTashkentWall(wall: Date): Date {
    return new Date(wall.getTime() - OrderAnalyticsService.TASHKENT_OFFSET_MS);
  }

  /**
   * Band boshi — TOSHKENT kuni/haftasi/oyi/yilining boshlanish LAHZASI.
   *
   * ⚠️ CODE-22: ilgari kun `setHours` bilan SERVER vaqtida (konteynerda UTC)
   * kesilardi, kalit esa Toshkentda formatlanardi. Toshkent oynasi UTC'da
   * oldingi kunning 19:00 ida boshlangani uchun skelet BITTA ORTIQCHA bo'sh
   * bandni (oynadan oldingi kun/hafta/oy) qo'shardi va `avgRevenue` jami /
   * (n + 1) bo'lib chiqardi. Endi skelet SQL kalitlari
   * (`tashkentPeriodKeySql`) bilan bir xil mintaqada quriladi.
   */
  private periodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = this.toTashkentWall(date);
    d.setUTCHours(0, 0, 0, 0);

    if (period === 'monthly') {
      d.setUTCDate(1);
    } else if (period === 'yearly') {
      d.setUTCMonth(0, 1);
    } else if (period === 'weekly') {
      // Hafta dushanbadan boshlanadi (Postgres `date_trunc('week')` kabi).
      const day = d.getUTCDay(); // 0=Sun..6=Sat
      const diffToMonday = day === 0 ? -6 : 1 - day;
      d.setUTCDate(d.getUTCDate() + diffToMonday);
    }
    return this.fromTashkentWall(d);
  }

  /** Keyingi band boshi (`date` — `periodStart` natijasi). */
  private nextPeriodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = this.toTashkentWall(date);
    if (period === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (period === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCFullYear(d.getUTCFullYear() + 1);
    return this.fromTashkentWall(d);
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
    const wall = this.toTashkentWall(d);
    if (period === 'monthly') {
      const y = wall.getUTCFullYear();
      const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
      return `M:${y}-${m}`;
    }
    return `Y:${wall.getUTCFullYear()}`;
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
      const end = new Date(d.getTime() + 6 * 24 * 60 * 60 * 1000);
      return `${this.dateLabel(d)}-${this.dateLabel(end)}`;
    }
    const wall = this.toTashkentWall(d);
    if (period === 'monthly') {
      const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
      return `${m}.${wall.getUTCFullYear()}`;
    }
    return String(wall.getUTCFullYear());
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
   *
   * ⚠️ HAR KARTANING O'Z SANASI BOR (menejer statistikasi):
   *   - "Sotilgan" (`orders_card.delivered`) — `sold_at` oynaga tushgan
   *     sotuvlar: sotuv QAYSI KUNI bo'lgan bo'lsa, o'sha kunda sanaladi
   *     (ilgari buyurtma YARATILGAN kun bo'yicha sanalardi). Doira — joriy
   *     ustunlar: sotilgan buyurtma boshqa joyga ko'chmaydi.
   *   - "Bekor qilingan" (`orders_card.cancelled`) — bekor QILINGAN kun
   *     bo'yicha, bekor paytida buyurtma shu filial yoki uning kuryerida
   *     bo'lgan bo'lsa (`countBranchCancelledOrders`). Tovar keyin HQ ga
   *     jo'natilsa ham raqam o'zgarmaydi. `returned` (RETURNED_TO_MARKET)
   *     o'zgarmagan holda qoladi.
   *   - Jami / bugun / hafta / market kartasi — hamon YARATILGAN kun
   *     bo'yicha, lekin doiraga saqlov tarixi (`order_custody_events`) ham
   *     qo'shilgan: filialdan chiqib ketgan buyurtma o'tgan kunlardan
   *     "yo'qolib" qolmaydi.
   *   - Yangi, Yo'lda, paketlar, faol kuryerlar — "hozir qo'lda nima bor"
   *     suratlari, joriy doirada qoladi.
   *
   * ⚠️ KECHIKISH. analytics-service `branch.dashboard` ni 5 s lik muddat va
   * qayta urinishlar bilan kutadi (gateway byudjeti 8 s). Shuning uchun yangi
   * hisoblar (sotilgan, bekor) MAVJUD `Promise.all` ichida parallel ketadi —
   * ikkinchi ketma-ket to'plam yo'q. Market nomlari esa market qatorlari
   * kelishi bilan (qolgan hisoblarni kutmasdan) 1,5 s lik, qayta urinishsiz
   * so'rov bilan olinadi va hech qachon xato otmaydi.
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

    // Jami/bugun/hafta/market kartasi uchun: saqlov tarixi bilan doira.
    const withCustodyHistory = { includeCustodyHistory: true };
    const scoped = (options: { includeCustodyHistory?: boolean } = {}) =>
      this.branchScopedQuery(branchIds, courierIds, options);
    const now = new Date();
    const todayStart = new Date(input.today_start);
    const weekStart = new Date(input.week_start);
    const rangeStart = input.start ? new Date(input.start) : null;
    const rangeEnd = input.end ? new Date(input.end) : now;

    const inRange = (options: { includeCustodyHistory?: boolean } = {}) => {
      const qb = scoped(options);
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

    // "Sotilgan" — SOTUV sanasi (`sold_at`, epoch ms) bo'yicha, joriy doirada.
    // "Barchasi" (start yo'q) — sana filtri qo'yilmaydi.
    const soldQuery = scoped().andWhere('o.status IN (:...soldStatuses)', {
      soldStatuses: deliveredStatuses,
    });
    if (rangeStart) {
      soldQuery.andWhere('o.sold_at BETWEEN :soldStartMs AND :soldEndMs', {
        soldStartMs: String(rangeStart.getTime()),
        soldEndMs: String(rangeEnd.getTime()),
      });
    }

    const marketRowsQuery = inRange(withCustodyHistory)
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
      }>();
    // Market nomlari market qatorlari kelishi bilan so'raladi — qolgan
    // hisoblarni kutmaydi, ular bilan parallel ketadi. getMarketNames hech
    // qachon xato otmaydi (xatoda bo'sh xarita).
    const marketNamesQuery = marketRowsQuery.then((rows) =>
      this.getMarketNames(rows.map((row) => String(row.market_id))),
    );

    const [
      todayCount,
      weekCount,
      selectedCount,
      activeBatches,
      statusRows,
      marketRows,
      packageRows,
      activeCouriers,
      soldCount,
      cancelledCount,
      marketNames,
    ] = await Promise.all([
      scoped(withCustodyHistory)
        .andWhere('o.createdAt BETWEEN :todayStart AND :now', {
          todayStart,
          now,
        })
        .getCount(),
      scoped(withCustodyHistory)
        .andWhere('o.createdAt BETWEEN :weekStart AND :now', { weekStart, now })
        .getCount(),
      inRange(withCustodyHistory).getCount(),
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
      marketRowsQuery,
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
      soldQuery.getCount(),
      // Bekor hisobi yiqilsa butun panel nolga tushmasin (branch-service
      // har qanday xatoda hamma raqamni 0 qiladi) — faqat shu karta 0.
      this.countBranchCancelledOrders({
        branchIds,
        courierIds,
        rangeStart,
        rangeEnd,
      }).catch((error: unknown) => {
        this.logger.warn(
          `Filial paneli: bekor qilinganlar hisobi olinmadi ` +
            `(branch_ids=${branchIds.join(',')}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return 0;
      }),
      marketNamesQuery,
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
        delivered: soldCount,
        returned: countOf([Order_status.RETURNED_TO_MARKET]),
        cancelled: cancelledCount,
      },
      markets: marketRows.map((row) => ({
        market_id: String(row.market_id),
        market_name: marketNames.get(String(row.market_id)) ?? null,
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
   *
   * `includeCustodyHistory` — buyurtma HOZIR filialda bo'lmasa ham, qachondir
   * filial yoki uning kuryeri qo'lidan o'tgan bo'lsa (`order_custody_events`)
   * doiraga kiradi. Aks holda HQ ga jo'natilgan tovar (HQ egasida
   * `holder_branch_id` NULL) filialning o'tgan kunlaridan yo'qolib qolardi.
   * Faqat "yaratilgan buyurtmalar" kartalari uchun; "hozir qo'lda nima bor"
   * kartalari joriy doirada qoladi.
   *
   * ⚠️ Ichki so'rov `getQuery()` bilan satr sifatida qo'shiladi — uning
   * parametrlari (`branchIds`, `courierIds`) TASHQI so'rovda ro'yxatga
   * olinadi. Bo'sh ro'yxat uchun `IN ()` hech qachon yozilmaydi.
   */
  private branchScopedQuery(
    branchIds: string[],
    courierIds: string[],
    options: { includeCustodyHistory?: boolean } = {},
  ) {
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
    if (options.includeCustodyHistory) {
      const historyConditions: string[] = [];
      if (branchIds.length) {
        historyConditions.push(
          'oce_hist.from_branch_id IN (:...branchIds)',
          'oce_hist.to_branch_id IN (:...branchIds)',
        );
      }
      if (courierIds.length) {
        historyConditions.push(
          'oce_hist.from_courier_id IN (:...courierIds)',
          'oce_hist.to_courier_id IN (:...courierIds)',
        );
      }
      if (historyConditions.length) {
        const custodyHistorySubQuery = this.orderCustodyEventRepo
          .createQueryBuilder('oce_hist')
          .select('1')
          .where('oce_hist.order_id = o.id')
          .andWhere(`(${historyConditions.join(' OR ')})`)
          .getQuery();
        conditions.push(`EXISTS (${custodyHistorySubQuery})`);
      }
    }
    qb.andWhere(`(${conditions.join(' OR ')})`, { branchIds, courierIds });
    return qb;
  }

  /**
   * "Bekor qilingan" kartasi — bekor QILINGAN kun bo'yicha.
   *
   * Sanaladi: oynada `to_status = cancelled` ga o'tgan va hali ham bekor
   * holatida turgan buyurtma, agar bekor paytida:
   *   - buyurtma shu filial yoki uning kuryerida bo'lgan bo'lsa — bekor
   *     paytigacha bo'lgan OXIRGI saqlov yozuvi (`holder_at`);
   *   - yoki bekorni filial kuryeri qilgan bo'lsa (`t.changed_by`);
   *   - yoki buyurtma shu filialda yaratilgan bo'lsa (`home_branch_id` —
   *     PICKUP o'zi yaratgan buyurtmalarning bekorini ham ko'radi; Sotilgan
   *     va Jami ham shunday sanaydi).
   *
   * Filtrlar:
   *   - `from_status` bekor oilasidan emas — bekor pochtasini qabul qilish
   *     (cancelled (sent) → cancelled) qayta sanalmaydi, qisman sotuv
   *     qoldig'i (from_status NULL) esa sanaladi;
   *   - `cancel_undo` — keyin bekordan chiqarilgan (masalan WAITING ga
   *     qaytarib sotilgan) buyurtma sanalmaydi, xuddi ortga qaytarilgan
   *     sotuvning `sold_at` i o'chgani kabi.
   *
   * Buyurtmaning JORIY branch/courier ustunlari ishlatilmaydi — tovar keyin
   * HQ ga jo'natilsa ham o'tgan kunning raqami o'zgarmaydi.
   *
   * ⚠️ SQL QOIDALARI (xato faqat Postgres'da ko'rinadi, mock testda emas):
   *   - ichki so'rovlar `getQuery()` bilan satr bo'lib qo'shiladi — ularning
   *     parametrlari TASHQI (`t`) so'rovda ro'yxatga olinadi;
   *   - bitta skalyar parametr ikki xil enum ustunida ishlatilmaydi (Postgres
   *     bitta `$N` ning turini aniqlay olmaydi). Massiv parametr har
   *     ishlatilishda alohida `$N` larga yoyiladi, shuning uchun
   *     `cancelFamily` ning bir necha enum ustunida ishlatilishi xavfsiz;
   *   - bo'sh ro'yxat uchun `IN ()` yozilmaydi.
   */
  private async countBranchCancelledOrders(input: {
    branchIds: string[];
    courierIds: string[];
    rangeStart: Date | null;
    rangeEnd: Date;
  }): Promise<number> {
    const { branchIds, courierIds, rangeStart, rangeEnd } = input;
    if (!branchIds.length && !courierIds.length) {
      return 0;
    }
    const cancelFamily = this.cancelledMarketStatuses();

    const cancelUndoSubQuery = this.orderTrackingRepo
      .createQueryBuilder('cancel_undo')
      .select('1')
      .where('cancel_undo.order_id = t.order_id')
      .andWhere('cancel_undo.created_at > t.created_at')
      .andWhere('cancel_undo.to_status NOT IN (:...cancelFamily)')
      .getQuery();

    const holderLaterSubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('holder_later')
      .select('1')
      .where('holder_later.order_id = holder_at.order_id')
      .andWhere('holder_later.created_at > holder_at.created_at')
      .andWhere('holder_later.created_at <= t.created_at')
      .getQuery();

    const holderConditions: string[] = [];
    if (branchIds.length) {
      holderConditions.push('holder_at.to_branch_id IN (:...branchIds)');
    }
    if (courierIds.length) {
      holderConditions.push('holder_at.to_courier_id IN (:...courierIds)');
    }
    // Bir tranzaksiyadagi yozuvlarning created_at i bir xil (Postgres now()),
    // shuning uchun `<=`: qisman sotuv qoldig'ining saqlov yozuvi ham topiladi.
    const holderAtSubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('holder_at')
      .select('1')
      .where('holder_at.order_id = t.order_id')
      .andWhere('holder_at.created_at <= t.created_at')
      .andWhere(`(${holderConditions.join(' OR ')})`)
      .andWhere(`NOT EXISTS (${holderLaterSubQuery})`)
      .getQuery();

    // Arzon ustun tekshiruvlari oldin, ichki so'rov oxirida.
    const attribution: string[] = [];
    if (courierIds.length) {
      attribution.push('t.changed_by IN (:...courierIds)');
    }
    if (branchIds.length) {
      attribution.push('o.home_branch_id IN (:...branchIds)');
    }
    attribution.push(`EXISTS (${holderAtSubQuery})`);

    const query = this.orderTrackingRepo
      .createQueryBuilder('t')
      .innerJoin(Order, 'o', 'o.id = t.order_id')
      .select('COUNT(DISTINCT t.order_id)', 'count')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.status IN (:...cancelFamily)', { cancelFamily })
      .andWhere('t.to_status = :cancelledStatus', {
        cancelledStatus: Order_status.CANCELLED,
      })
      .andWhere(
        '(t.from_status IS NULL OR t.from_status NOT IN (:...cancelFamily))',
        { cancelFamily },
      )
      .andWhere(`NOT EXISTS (${cancelUndoSubQuery})`, { cancelFamily })
      .andWhere(`(${attribution.join(' OR ')})`, { branchIds, courierIds });

    if (rangeStart) {
      query.andWhere('t.created_at BETWEEN :cancelStart AND :cancelEnd', {
        cancelStart: rangeStart,
        cancelEnd: rangeEnd,
      });
    }

    const row = await query.getRawOne<{ count?: string | number }>();
    return Number(row?.count ?? 0);
  }

  /**
   * Market kartasi uchun nomlar. `identity.market.find_by_ids` javobidan
   * FAQAT `name` olinadi — market qatori to'liq uzatilmaydi (unda maxfiy
   * maydonlar, masalan `market_tg_token`, bor).
   *
   * ⚠️ 1,5 s, QAYTA URINISHSIZ. `lookup.getMarketsByIds` rmqSend sukutlarida
   * ishlaydi (5 s × 3 urinish) — bu filial panelining 8 s lik gateway
   * byudjetini buzardi. Hech qachon xato otmaydi: identity javob bermasa bo'sh
   * xarita qaytadi va frontend "Market N" yorlig'ini ko'rsatadi.
   */
  private async getMarketNames(
    marketIds: string[],
  ): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const ids = Array.from(
      new Set(marketIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
    );
    if (!ids.length) {
      return names;
    }

    const response = await rmqSend<{
      data?: Array<{ id?: string | number | null; name?: string | null }>;
    }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids },
      { timeoutMs: 1500, retries: 0, attachRequestId: false },
    ).catch((error: unknown) => {
      this.logger.warn(
        `Filial paneli: market nomlari olinmadi (ids=${ids.length}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });

    const rows = Array.isArray(response?.data) ? response.data : [];
    for (const row of rows) {
      const id = String(row?.id ?? '').trim();
      if (!id) continue;
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      names.set(id, name || null);
    }
    return names;
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
        cancelled: 0,
      },
      markets: [] as Array<{
        market_id: string;
        market_name: string | null;
        orders_count: number;
        delivered_count: number;
        total_price: number;
      }>,
      packages: { on_the_way: 0, waiting_for_acceptance: 0 },
      active_couriers: 0,
    };
  }

  /**
   * BEKOR QILISH SABABLARI KESIMIDA STATISTIKA (PUvKXWVw).
   *
   * Sabab yopiq ro'yxatdan `return_reason` ga yoziladi — hisobot "qaysi
   * market/tuman/kuryer qanday sabab bilan qaytaryapti" savoliga javob beradi.
   *
   * Qaysi buyurtma "bekor qilingan" (2026-10-15 tuzatishlari):
   *   • ISBOT — `order_tracking` dagi `to_status = cancelled` yozuvi (asl bekor;
   *     `cancelled (sent) → cancelled` — bekor pochtasini qabul qilish —
   *     qayta sanalmaydi) va undan KEYIN bekor oilasidan tashqari holatga
   *     o'tish YO'Q (rollback qilib sotilgani sanalmaydi). Ilgari faqat joriy
   *     holatga qaralardi: qaytarish so'rovi bilan marketga qaytgan (hech
   *     qachon bekor qilinmagan) buyurtma erkin matnli `return_reason` i bilan
   *     ro'yxatga tushardi;
   *   • joriy holat bekor oilasida — `CLOSED` ham (F4 dan oldin marketga
   *     topshirilgan bekorlar shu holatda; ilgari ular hisobotdan yo'qolardi);
   *   • sana oynasi shu bekor yozuviga, TOSHKENT kuni bo'yicha
   *     (`YYYY-MM-DD` → 00:00:00.000 … 23:59:59.999 +05:00). Ilgari
   *     `new Date('2026-10-15')` UTC yarim tun edi: `endDate` kunining o'zi
   *     butunlay tushib qolardi;
   *   • ro'yxatda yo'q / bo'sh sabab — `UNKNOWN`. `by_reason` da yopiq
   *     ro'yxatning HAR sababi (0 bo'lsa ham) yorlig'i bilan qaytadi.
   *   • filial doirasi — boshqa analitikadagi `applyAnalyticsBranchScope`
   *     (joriy filial / ushlovchi / saqlov tarixi) + yaratilgan filial.
   *     Ilgari `COALESCE(home, branch, holder)` HQ'da yaratilgan buyurtmani
   *     filial kuryeri bekor qilsa ham filialdan yashirardi.
   *
   * SQL GROUP BY — qatorlar xotiraga yuklanmaydi, shuning uchun oyna
   * `MAX_ANALYTICS_SPAN_MS` bilan qisqartirilmaydi.
   */
  async getCancelReasonStats(input: {
    startDate?: string;
    endDate?: string;
    market_id?: string;
    branch_id?: string;
    group_by?: 'market' | 'region' | 'courier';
  }) {
    const groupColumns: Record<string, string> = {
      market: 'o.market_id',
      region: 'o.region_id',
      courier: 'o.courier_id',
    };
    const groupBy = input?.group_by ? groupColumns[input.group_by] : null;
    if (input?.group_by && !groupBy) {
      throw new RpcException({
        statusCode: 400,
        message:
          "group_by faqat 'market', 'region' yoki 'courier' bo'lishi mumkin",
      });
    }
    const from = parseTashkentBoundary(input?.startDate, false);
    const to = parseTashkentBoundary(input?.endDate, true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new RpcException({
        statusCode: 400,
        message: "startDate endDate dan keyin bo'lmasligi kerak",
      });
    }

    const knownReasons = Object.values(CancelReason) as string[];
    const cancelFamily = [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
      Order_status.RETURNED_TO_MARKET,
    ];
    // Xom `return_reason` bo'yicha guruhlanadi, ro'yxatda yo'q qiymat
    // pastda (JS) `UNKNOWN` ga yig'iladi — SELECT/GROUP BY ifodasi
    // parametrsiz qoladi.
    const reasonExpression = 'o.return_reason';

    // Bekor yozuvidan KEYIN bekor oilasidan tashqari holat (rollback) yo'q.
    const undone = this.orderTrackingRepo
      .createQueryBuilder('cr_undo')
      .select('1')
      .where('cr_undo.order_id = cr.order_id')
      .andWhere('cr_undo.created_at > cr.created_at')
      .andWhere('cr_undo.to_status NOT IN (:...undoFamily)');
    const cancelled = this.orderTrackingRepo
      .createQueryBuilder('cr')
      .select('1')
      .where('cr.order_id = o.id')
      .andWhere('cr.to_status = :cancelledTrackingStatus')
      .andWhere(
        '(cr.from_status IS NULL OR cr.from_status NOT IN (:...fromFamily))',
      );
    if (from) cancelled.andWhere('cr.created_at >= :cancelFrom');
    if (to) cancelled.andWhere('cr.created_at <= :cancelTo');
    cancelled.andWhere(`NOT EXISTS (${undone.getQuery()})`);

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.status IN (:...statuses)', { statuses: cancelFamily })
      .andWhere(`EXISTS (${cancelled.getQuery()})`, {
        cancelledTrackingStatus: Order_status.CANCELLED,
        // Massiv parametrlar har ishlatilishda alohida `$N` ga yoyiladi —
        // turli enum ustunlarida (orders.status / tracking.*) xavfsiz.
        fromFamily: cancelFamily,
        undoFamily: cancelFamily,
        ...(from ? { cancelFrom: from } : {}),
        ...(to ? { cancelTo: to } : {}),
      })
      .select(reasonExpression, 'reason')
      .addSelect('COUNT(*)', 'count')
      .groupBy(reasonExpression);

    if (input?.market_id) {
      qb.andWhere('o.market_id = :marketId', {
        marketId: String(input.market_id),
      });
    }
    if (input?.branch_id) {
      const branchId = String(input.branch_id);
      const custodySubQuery = this.orderCustodyEventRepo
        .createQueryBuilder('oce')
        .select('1')
        .where('oce.order_id = o.id')
        .andWhere(
          '(oce.from_branch_id = :cancelBranchId OR oce.to_branch_id = :cancelBranchId)',
        )
        .getQuery();
      qb.andWhere(
        `(
          o.branch_id = :cancelBranchId
          OR o.holder_branch_id = :cancelBranchId
          OR o.home_branch_id = :cancelBranchId
          OR EXISTS (${custodySubQuery})
        )`,
        { cancelBranchId: branchId },
      );
    }
    if (groupBy) {
      qb.addSelect(groupBy, 'key').addGroupBy(groupBy);
    }

    const rawRows = await qb.getRawMany<{
      reason: string | null;
      count: string;
      key?: string | null;
    }>();
    const normalizeReason = (reason: string | null) =>
      reason && knownReasons.includes(reason) ? reason : CANCEL_REASON_UNKNOWN;
    const order = (reason: string) => {
      const index = knownReasons.indexOf(reason);
      return index === -1 ? knownReasons.length : index;
    };
    const labelOf = (reason: string) =>
      CANCEL_REASON_UZ[reason] ?? CANCEL_REASON_UNKNOWN_UZ;

    // Yopiq ro'yxatning har sababi (0 bo'lsa ham) — UI to'liq ro'yxat chizadi.
    const byReason = new Map<string, number>(
      knownReasons.map((reason) => [reason, 0]),
    );
    const byReasonKey = new Map<
      string,
      { reason: string; key: string | null; count: number }
    >();
    for (const row of rawRows) {
      const reason = normalizeReason(row.reason);
      const count = Number(row.count) || 0;
      byReason.set(reason, (byReason.get(reason) ?? 0) + count);
      if (groupBy) {
        const key =
          row.key !== null && row.key !== undefined ? String(row.key) : null;
        const mapKey = `${reason}\u0000${key ?? ''}`;
        const current = byReasonKey.get(mapKey);
        if (current) current.count += count;
        else byReasonKey.set(mapKey, { reason, key, count });
      }
    }
    const total = Array.from(byReason.values()).reduce((a, b) => a + b, 0);
    return {
      total,
      by_reason: Array.from(byReason.entries())
        // `UNKNOWN` faqat haqiqatan bo'lsa chiqadi.
        .filter(
          ([reason, count]) => reason !== CANCEL_REASON_UNKNOWN || count > 0,
        )
        .map(([reason, count]) => ({ reason, label: labelOf(reason), count }))
        .sort((a, b) => b.count - a.count || order(a.reason) - order(b.reason)),
      applied_range: {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        timezone: 'Asia/Tashkent',
      },
      ...(groupBy
        ? {
            group_by: input.group_by,
            rows: Array.from(byReasonKey.values()).sort(
              (a, b) =>
                b.count - a.count ||
                order(a.reason) - order(b.reason) ||
                String(a.key ?? '').localeCompare(String(b.key ?? '')),
            ),
          }
        : {}),
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

    const [acceptedCount, cancelledStats, aggregate] = await Promise.all([
      this.countDashboardAcceptedOrders(range, branchId),
      // (l9NNdsCH) soni + summasi bitta so'rovda (AYNI to'plam).
      this.historicallyCancelledCountAndAmount(range, branchId),
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
      cancelled: cancelledStats.count,
      // (l9NNdsCH) «Yo'qotilgan daromad» — davrda bekor qilingan
      // buyurtmalarning `total_price` yig'indisi (`cancelled` bilan AYNI to'plam).
      lostRevenue: cancelledStats.amount,
      soldAndPaid: Number(aggregate?.sold_count ?? 0),
      profit: Number(aggregate?.profit ?? 0),
      totalRevenue: Number(aggregate?.revenue ?? 0),
      from: range?.start.getTime(),
      to: range?.end.getTime(),
      applied_range: range.applied_range,
    };
  }

  async getMarketStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    all = false,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate, all);
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
    all = false,
    includeDetail = false,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate, all);
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
    if (!includeDetail) {
      return result;
    }

    // juZFa64U: kuryerlar hisoboti — har kuryer uchun alohida
    // `order.analytics.courier_stat` o'rniga bekor qilinganlar va daromad
    // (`getCourierStat` dagi AYNI qoida) shu javobning o'zida, bitta
    // to'plamli so'rovda.
    const details = await this.getCourierReportDetails(
      result.map((row) => String(row.courier?.id ?? '')),
      startDate,
      endDate,
      all,
    );
    return result.map((row) => {
      const detail = details.get(String(row.courier?.id ?? '')) ?? {
        canceledOrders: 0,
        profit: 0,
      };
      return {
        ...row,
        canceledOrders: detail.canceledOrders,
        profit: detail.profit,
      };
    });
  }

  /**
   * juZFa64U — KURYERLAR HISOBOTINING N+1 SI OLIB TASHLANDI.
   *
   * Ilgari analytics-service har kuryer uchun alohida
   * `order.analytics.courier_stat` yuborardi, u esa har safar BARCHA
   * pochtalarni (`getAllPostsForAnalytics`, sahifama-sahifa RMQ) qayta
   * yuklab, uchta so'rov bajarardi — N kuryer ≈ N × (pochta sahifalari + 3).
   * Prod o'lchovi: 8 kuryerda sovuq kesh 1384 ms / issiq 121 ms.
   *
   * Endi: pochtalar BIR marta yuklanadi va bitta SQL barcha kuryerlar uchun
   * `getCourierStat` bilan AYNAN bir xil sonlarni beradi:
   *   - doira (applyAnalyticsCourierScope): o.courier_id = K, YOKI
   *     o.holder_courier_id = K, YOKI o.post_id K ning pochtalaridan, YOKI
   *     custody hodisasida from/to_courier_id = K — `pairs` CTE'sida
   *     (buyurtma, kuryer) juftlari UNION (takrorsiz) bilan;
   *   - profit: sotilgan (SOLD/PAID/PARTLY_PAID), sold_at oynada,
   *     SUM(COALESCE(courier_share, courier_tariff, 0));
   *   - canceledOrders (countHistoricallyCancelledOrders, filialsiz):
   *     tracking'da CANCELLED/CANCELLED_SENT/CLOSED ga o'tish (action
   *     'cancelled_post_received' emas), created_at oynada,
   *     COUNT(DISTINCT order_id).
   * Teng natija `courier-report-batch.juZFa64U.pg.spec.ts` da haqiqiy
   * Postgres'da eski yo'l bilan solishtiriladi.
   */
  async getCourierReportDetails(
    courierIds: string[],
    startDate?: string,
    endDate?: string,
    all = false,
  ): Promise<Map<string, { canceledOrders: number; profit: number }>> {
    const ids = Array.from(
      new Set(
        courierIds
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );
    const details = new Map<
      string,
      { canceledOrders: number; profit: number }
    >();
    if (!ids.length) {
      return details;
    }
    const range = this.resolveAnalyticsRange(startDate, endDate, all);
    const idSet = new Set(ids);
    const posts = (await this.getAllPostsForAnalytics()).filter((post) =>
      idSet.has(String(post.courier_id ?? '').trim()),
    );
    const postIds = posts.map((post) => String(post.id));
    const postCourierIds = posts.map((post) => String(post.courier_id));

    const quote = (tablePath: string) =>
      tablePath
        .split('.')
        .map((part) => `"${part}"`)
        .join('.');
    const orders = quote(this.orderRepo.metadata.tablePath);
    const tracking = quote(this.orderTrackingRepo.metadata.tablePath);
    const custody = quote(this.orderCustodyEventRepo.metadata.tablePath);

    const rows = await this.orderRepo.query<
      Array<{ courier_id: string; profit: string | null; canceled: number }>
    >(
      `WITH cs AS (
         SELECT DISTINCT unnest($1::bigint[]) AS courier_id
       ),
       pc AS (
         SELECT unnest($2::bigint[]) AS post_id,
                unnest($3::bigint[]) AS courier_id
       ),
       pairs AS (
         SELECT o.id AS order_id, o.courier_id AS courier_id
           FROM ${orders} o JOIN cs ON cs.courier_id = o.courier_id
         UNION
         SELECT o.id, o.holder_courier_id
           FROM ${orders} o JOIN cs ON cs.courier_id = o.holder_courier_id
         UNION
         SELECT o.id, pc.courier_id
           FROM ${orders} o JOIN pc ON pc.post_id = o.post_id
         UNION
         SELECT e.order_id, e.from_courier_id
           FROM ${custody} e JOIN cs ON cs.courier_id = e.from_courier_id
         UNION
         SELECT e.order_id, e.to_courier_id
           FROM ${custody} e JOIN cs ON cs.courier_id = e.to_courier_id
       ),
       sold AS (
         SELECT p.courier_id,
                COALESCE(SUM(COALESCE(o.courier_share, o.courier_tariff, 0)), 0) AS profit
           FROM pairs p JOIN ${orders} o ON o.id = p.order_id
          WHERE o.is_deleted = false
            AND o.status::text = ANY($4::text[])
            AND o.sold_at BETWEEN $5::bigint AND $6::bigint
          GROUP BY p.courier_id
       ),
       canceled AS (
         SELECT p.courier_id, COUNT(DISTINCT t.order_id)::int AS canceled
           FROM pairs p
           JOIN ${orders} o ON o.id = p.order_id
           JOIN ${tracking} t ON t.order_id = o.id
          WHERE o.is_deleted = false
            AND t.to_status::text = ANY($7::text[])
            AND (t.action IS NULL OR t.action != $8)
            -- T8: from = to (holat o'zgarmagan yozuv) — bekor emas.
            AND t.from_status::text IS DISTINCT FROM t.to_status::text
            AND t.created_at BETWEEN $9 AND $10
          GROUP BY p.courier_id
       )
       SELECT cs.courier_id::text AS courier_id,
              sold.profit AS profit,
              COALESCE(canceled.canceled, 0)::int AS canceled
         FROM cs
         LEFT JOIN sold ON sold.courier_id = cs.courier_id
         LEFT JOIN canceled ON canceled.courier_id = cs.courier_id`,
      [
        ids,
        postIds,
        postCourierIds,
        this.soldStatuses(),
        String(range.start.getTime()),
        String(range.end.getTime()),
        [
          Order_status.CANCELLED,
          Order_status.CANCELLED_SENT,
          Order_status.CLOSED,
        ],
        'cancelled_post_received',
        range.start,
        range.end,
      ],
    );

    for (const row of rows) {
      details.set(String(row.courier_id), {
        canceledOrders: Number(row.canceled ?? 0),
        profit: Number(row.profit ?? 0),
      });
    }
    return details;
  }

  async getTopMarkets(
    limit = 10,
    branchId?: string,
    startDate?: string,
    endDate?: string,
    minOrders = 1,
    includeMeta = false,
    all = false,
  ) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const range =
      startDate && endDate
        ? this.analyticsDateRange(startDate, endDate, all)
        : null;
    const fromDate =
      range?.start ?? (startDate ? new Date(startDate) : lastMonth);
    const toDate = range?.end ?? (endDate ? new Date(endDate) : undefined);
    const threshold = this.normalizeRankingMinOrders(minOrders);

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
      .filter((row) => Number(row.total_orders) >= threshold)
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
      .sort(OrderAnalyticsService.compareRanking)
      .slice(0, limit);

    return this.rankingResult(
      result,
      threshold,
      totalsRaw.filter((row) => Number(row.total_orders) < threshold).length,
      includeMeta,
      { from: fromDate, to: toDate },
    );
  }

  private normalizeRankingMinOrders(value: number): number {
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  }

  /**
   * (PQt3n1N0) Reyting tartibi: muvaffaqiyat ulushi, teng bo'lsa — buyurtmalar
   * soni. `>= 30` chegarasi olib tashlangach 1 buyurtmali 100% market 59
   * buyurtmali 100% marketdan oldinga chiqib qolmasin.
   */
  private static readonly compareRanking = (
    a: { success_rate: number; total_orders: number },
    b: { success_rate: number; total_orders: number },
  ): number =>
    b.success_rate - a.success_rate || b.total_orders - a.total_orders;

  /**
   * (PQt3n1N0, 9zbSDkUI) `include_meta` da reyting qatorlari bilan birga
   * chegara (`min_orders`), shu sababli tushib qolganlar soni
   * (`filtered_out`) va reyting HISOBLANGAN davr (`from`/`to`, ISO) qaytadi —
   * frontend bo'sh holat sababini va "qaysi davr" yorlig'ini serverdan oladi.
   */
  private rankingResult<T>(
    items: T[],
    minOrders: number,
    filteredOut: number,
    includeMeta: boolean,
    period?: { from?: Date | null; to?: Date | null },
  ) {
    return includeMeta
      ? {
          items,
          min_orders: minOrders,
          filtered_out: filteredOut,
          from: period?.from ? period.from.toISOString() : null,
          to: period?.to ? period.to.toISOString() : null,
        }
      : items;
  }

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich). Ilgari oxirgi 30 kunning BARCHA
   * buyurtmalari yuklanib JS'da sanalardi. Endi `GROUP BY post_id`.
   */
  async getTopCouriers(
    limit = 10,
    branchId?: string,
    startDate?: string,
    endDate?: string,
    minOrders = 1,
    includeMeta = false,
    all = false,
  ) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const range =
      startDate && endDate
        ? this.analyticsDateRange(startDate, endDate, all)
        : null;
    const start = range?.start ?? (startDate ? new Date(startDate) : lastMonth);
    const end = range?.end ?? (endDate ? new Date(endDate) : new Date());
    const threshold = this.normalizeRankingMinOrders(minOrders);

    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
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
      return this.rankingResult([], threshold, 0, includeMeta, {
        from: start,
        to: end,
      });
    }

    const posts = await this.getPostsByIds(
      rows.map((row) => String(row.post_id)),
    );
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    // Kuryersiz pochtada courier_id "0" satri — truthy, `filter(Boolean)` dan
    // o'tib reytingda nomsiz soxta qator bo'lardi (min_orders=1 dan beri ko'rinadi).
    const isCourierId = (id: unknown): id is string | number =>
      (typeof id === 'string' || typeof id === 'number') &&
      /^[1-9]\d*$/.test(String(id));
    const courierIds = [
      ...new Set(
        posts
          .map((p) => p.courier_id)
          .filter(isCourierId)
          .map(String),
      ),
    ];
    const couriers = await this.lookup.getCouriersByIds(courierIds);
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    const stats = new Map<string, { total: number; successful: number }>();
    for (const row of rows) {
      const courierId = postMap.get(String(row.post_id))?.courier_id;
      if (!isCourierId(courierId)) continue;
      const current = stats.get(String(courierId)) ?? {
        total: 0,
        successful: 0,
      };
      current.total += Number(row.total) || 0;
      current.successful += Number(row.successful) || 0;
      stats.set(String(courierId), current);
    }

    const ranked = Array.from(stats.entries()).map(([courierId, current]) => {
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
    });
    const filteredOut = ranked.filter(
      (row) => row.total_orders < threshold,
    ).length;
    const result = ranked
      .filter((row) => row.total_orders >= threshold)
      .sort(OrderAnalyticsService.compareRanking)
      .slice(0, limit);
    return this.rankingResult(result, threshold, filteredOut, includeMeta, {
      from: start,
      to: end,
    });
  }

  async getTopBranches(
    limit = 10,
    branchId?: string,
    startDate?: string,
    endDate?: string,
    minOrders = 1,
    includeMeta = false,
    all = false,
  ) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const range =
      startDate && endDate
        ? this.analyticsDateRange(startDate, endDate, all)
        : null;
    const fromDate =
      range?.start ?? (startDate ? new Date(startDate) : lastMonth);
    const toDate = range?.end ?? (endDate ? new Date(endDate) : undefined);
    const threshold = this.normalizeRankingMinOrders(minOrders);

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

    const eligible = rows.filter(
      (row) => branchMap.get(String(row.branch_id))?.type !== BranchType.HQ,
    );
    const result = eligible
      .filter((row) => Number(row.total_orders) >= threshold)
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
      .sort(OrderAnalyticsService.compareRanking)
      .slice(0, limit);
    return this.rankingResult(
      result,
      threshold,
      eligible.filter((row) => Number(row.total_orders) < threshold).length,
      includeMeta,
      { from: fromDate, to: toDate },
    );
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
        { start: range.start, end: range.end },
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
      // (uN1tjjGu) kuryer dashboardi ham qo'llangan oraliqni ko'rsin.
      applied_range: range.applied_range,
    };
  }

  /** (mKS1mjNr) KPI SLA chegarasi: yaratilgandan 24 soat ichida sotilgan. */
  private static readonly FULFILLMENT_SLA_MS = 24 * 60 * 60 * 1000;

  /**
   * (mKS1mjNr) KPI "o'rtacha yetkazish vaqti" va "o'z vaqtida" ulushi —
   * BITTA SQL agregatsiyasi.
   *
   * ⚠️ ILGARI analytics-service davrdagi BARCHA sotilgan buyurtmalarni
   * `order.find_all` orqali 200 talik sahifalarda tortardi (4 status ×
   * 100 sahifa = 80 000 qatorgacha, har sahifa alohida RMQ) va JS'da
   * `sold_at − createdAt` ni yig'ardi — ma'lumot o'sishi bilan KPI gateway'ning
   * 10 s chegarasiga urilardi. Mantiq O'SHA: o'chirilmagan, statusi SOLD /
   * PAID / CLOSED / PARTLY_PAID, `createdAt` oynada, `sold_at` bor va farq
   * > 0; SLA — farq ≤ 24 soat. Farq ms da: `sold_at` (epoch ms, bigint)
   * minus `createdAt` ning epoch ms i (JS `Date` kabi ms gacha kesilgan).
   * Oyna chegaralari Toshkent kuni bo'yicha `analyticsDateRange` dan (SQL'da
   * qo'shimcha `AT TIME ZONE` yo'q — instantlar solishtiriladi).
   * Postgres SUM/COUNT natijasi SATR keladi — `Number()` bilan.
   */
  /** Yetkazish vaqti (ms): `sold_at` − `createdAt` (epoch ms). */
  private static readonly FULFILLMENT_DELIVERY_MS_SQL =
    '(o.sold_at::bigint - FLOOR(EXTRACT(EPOCH FROM o.createdAt) * 1000))';

  /**
   * (mKS1mjNr) KPI yetkazish tanlovi: o'chirilmagan, SOLD/PAID/CLOSED/
   * PARTLY_PAID, `createdAt` oynada, `sold_at` bor va farq > 0. (DwrMygfo:
   * kunlik seriya ham AYNI tanlovdan.)
   */
  private fulfillmentBaseQuery(start: Date, end: Date, branchId?: string) {
    const statuses = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.CLOSED,
      Order_status.PARTLY_PAID,
    ];
    return this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...fulfillmentStatuses)', {
          fulfillmentStatuses: statuses,
        })
        .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.sold_at IS NOT NULL')
        .andWhere(`${OrderAnalyticsService.FULFILLMENT_DELIVERY_MS_SQL} > 0`),
      branchId,
    );
  }

  async getFulfillmentStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    // (XdKajqLe) «Barchasi» — overview bilan AYNI oyna (366 kunlik chegara).
    all = false,
  ) {
    const { start, end, applied_range } = this.analyticsDateRange(
      startDate,
      endDate,
      all,
    );
    const deliveryMs = OrderAnalyticsService.FULFILLMENT_DELIVERY_MS_SQL;

    const row = await this.fulfillmentBaseQuery(start, end, branchId)
      .select('COUNT(*)', 'delivered_count')
      .addSelect(`COALESCE(SUM(${deliveryMs}), 0)::float8`, 'delivery_ms_total')
      .addSelect(
        `COUNT(*) FILTER (WHERE ${deliveryMs} <= :fulfillmentSlaMs)`,
        'on_time_count',
      )
      .setParameter(
        'fulfillmentSlaMs',
        OrderAnalyticsService.FULFILLMENT_SLA_MS,
      )
      .getRawOne<{
        delivered_count: string | number | null;
        delivery_ms_total: string | number | null;
        on_time_count: string | number | null;
      }>();

    const toNumber = (value: unknown) => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      deliveredCount: toNumber(row?.delivered_count),
      deliveryMsTotal: toNumber(row?.delivery_ms_total),
      onTimeCount: toNumber(row?.on_time_count),
      slaMs: OrderAnalyticsService.FULFILLMENT_SLA_MS,
      applied_range,
    };
  }

  // -------------------------------------------------------------------
  // (W20LoskP) "Buyurtmalar hisoboti" agregatlari — SQL GROUP BY.
  //
  // ⚠️ ILGARI analytics-service davrdagi barcha buyurtmalarni `order.find_all`
  // orqali sahifalab tortardi (100 sahifa × 100 = eng ko'pi 10 000 qator,
  // 100 ta ketma-ket RMQ) va viloyat/mahsulotni JS'da sanardi — 10 000 dan
  // keyin natija JIM kesilardi. Status taqsimoti esa qo'lda yozilgan 9 ta
  // status bo'yicha 9 ta alohida `count` edi: CREATED / WAITING /
  // WAITING_CUSTOMER / RETURNED_TO_MARKET umuman yo'q edi (18 ta 'waiting'
  // diagrammadan yo'qolardi, yig'indi `acceptedCount` dan kam chiqardi).
  //
  // Tanlov `countDashboardAcceptedOrders` (overview.acceptedCount) bilan AYNI:
  // o'chirilmagan, `createdAt` oynada (Toshkent kuni, `analyticsDateRange`,
  // 366 kunlik chegara), ixtiyoriy filial doirasi — shuning uchun status
  // taqsimotining yig'indisi `acceptedCount` ga teng.
  // -------------------------------------------------------------------

  private orderReportBaseQuery(
    range: { start: Date; end: Date },
    branchId?: string,
  ) {
    return this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt BETWEEN :start AND :end', {
          start: range.start,
          end: range.end,
        }),
      branchId,
    );
  }

  /** (W20LoskP) Har bir `Order_status` kaliti (0 bo'lsa ham) — bitta GROUP BY. */
  async getOrderStatusDistribution(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const range = this.analyticsDateRange(startDate, endDate);
    const rows = await this.orderReportBaseQuery(range, branchId)
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('o.status')
      .getRawMany<{ status: string; count: string | number | null }>();

    const distribution: Record<string, number> = {};
    for (const status of Object.values(Order_status)) {
      distribution[status] = 0;
    }
    let total = 0;
    for (const row of rows) {
      const count = Number(row?.count ?? 0);
      if (!Number.isFinite(count)) continue;
      const key = String(row?.status ?? 'unknown');
      distribution[key] = (distribution[key] ?? 0) + count;
      total += count;
    }
    return { distribution, total, applied_range: range.applied_range };
  }

  /** (W20LoskP) Viloyat kesimi — `GROUP BY region_id`, cheklovsiz to'liq. */
  async getOrdersByRegion(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const range = this.analyticsDateRange(startDate, endDate);
    const rows = await this.orderReportBaseQuery(range, branchId)
      .select('o.region_id', 'region_id')
      .addSelect('COUNT(*)', 'total_orders')
      .groupBy('o.region_id')
      .getRawMany<{
        region_id: string | number | null;
        total_orders: string | number | null;
      }>();

    // Eski JS hisobi bilan bir xil shakl: region yo'q → 'unknown'.
    const items = rows
      .map((row) => ({
        region_id:
          row?.region_id === null || row?.region_id === undefined
            ? 'unknown'
            : String(row.region_id),
        total_orders: Number(row?.total_orders ?? 0) || 0,
      }))
      .sort(
        (a, b) =>
          b.total_orders - a.total_orders ||
          a.region_id.localeCompare(b.region_id, 'en', { numeric: true }),
      );
    const total = items.reduce((sum, row) => sum + row.total_orders, 0);
    return { items, total, applied_range: range.applied_range };
  }

  /**
   * (W20LoskP) Eng ko'p buyurtma qilingan mahsulotlar — `order_items` ⋈
   * `orders`, `SUM(quantity) GROUP BY product_id`. Eski JS hisobi bilan bir
   * xil: davrda yaratilgan barcha (o'chirilmagan) buyurtmalar, katalogsiz
   * qator (`product_id` NULL) → 'unknown'.
   */
  async getTopOrderedProducts(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    limit = 10,
  ) {
    const range = this.analyticsDateRange(startDate, endDate);
    const parsedLimit = Math.floor(Number(limit));
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 50)
        : 10;
    const rows = await this.orderReportBaseQuery(range, branchId)
      .innerJoin('o.items', 'oi')
      .select('oi.product_id', 'product_id')
      .addSelect('COALESCE(SUM(oi.quantity), 0)', 'total_quantity')
      .groupBy('oi.product_id')
      .orderBy('total_quantity', 'DESC')
      .addOrderBy('oi.product_id', 'ASC', 'NULLS LAST')
      .limit(safeLimit)
      .getRawMany<{
        product_id: string | number | null;
        total_quantity: string | number | null;
      }>();

    return {
      items: rows.map((row) => ({
        product_id:
          row?.product_id === null || row?.product_id === undefined
            ? 'unknown'
            : String(row.product_id),
        total_quantity: Number(row?.total_quantity ?? 0) || 0,
      })),
      limit: safeLimit,
      applied_range: range.applied_range,
    };
  }

  /**
   * (Celz3rKJ) "AI xarajat" panelidagi buyurtma manbasi uchun: davrda
   * yaratilgan buyurtmalar `source` bo'yicha (tanlov `acceptedCount` bilan
   * AYNI). `external` — `findAll` dagi kabi `source = external` YOKI
   * `external_id` bor; `branch` — filial yaratgan; `bot` — Telegram bot
   * WebApp (`created_via = 'bot'`); qolgani `internal` (admin paneli,
   * market/operator, shu jumladan AI orqali yaratilganlar). Har buyurtma
   * AYNAN bitta bucket'da: `internal + external + branch + bot = total`.
   * Ustun qo'shilishidan oldingi bot buyurtmalari `internal` da (backfill yo'q).
   */
  async getOrderSourceDistribution(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const range = this.analyticsDateRange(startDate, endDate);
    const bucket = `CASE
        WHEN o.source = 'branch' THEN 'branch'
        WHEN o.source = 'external' OR o.external_id IS NOT NULL THEN 'external'
        WHEN o.created_via = 'bot' THEN 'bot'
        ELSE 'internal'
      END`;
    const rows = await this.orderReportBaseQuery(range, branchId)
      .select(bucket, 'bucket')
      .addSelect('COUNT(*)', 'count')
      .groupBy('bucket')
      .getRawMany<{ bucket: string; count: string | number | null }>();

    const counts = { internal: 0, external: 0, branch: 0, bot: 0 };
    for (const row of rows) {
      const key = String(row?.bucket) as keyof typeof counts;
      if (key in counts) {
        counts[key] += Number(row?.count ?? 0) || 0;
      }
    }
    return {
      ...counts,
      total: counts.internal + counts.external + counts.branch + counts.bot,
      applied_range: range.applied_range,
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
  async getMarketStat(
    marketId: string,
    startDate?: string,
    endDate?: string,
    all = false,
  ) {
    const { start, end, applied_range } = this.analyticsDateRange(
      startDate,
      endDate,
      all,
    );
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
      // (uN1tjjGu) market dashboardi ham qo'llangan oraliqni ko'rsin.
      applied_range,
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
    // (6CYRjoZG) SA/ADMIN filial sahifasi «Kunlik daromad» — filial kesimi
    // (`overview` bilan AYNI `applyAnalyticsBranchScope` qoidasi).
    branchId?: string,
    // (XdKajqLe) «Barchasi»: overview bilan AYNI qoida — 1970 → endDate,
    // eng so'nggi 366 kunga qisqartiriladi (audit C3), `applied_range` da.
    all = false,
  ) {
    const normalizedPeriod = this.normalizeRevenuePeriod(period);
    const { start, end, applied_range } = this.analyticsDateRange(
      startDate,
      endDate,
      all,
    );
    const soldStatuses = this.soldStatuses();
    const keySql = this.tashkentPeriodKeySql(normalizedPeriod);

    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
          startMs: String(start.getTime()),
          endMs: String(end.getTime()),
        })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      branchId,
    )
      .select(keySql, 'period_key')
      .addSelect('COUNT(*)', 'orders_count')
      .addSelect('COALESCE(SUM(o.total_price), 0)', 'revenue')
      // (l9NNdsCH) «Sof foyda» trendi — overview `profit` bilan AYNI formula.
      .addSelect(OrderAnalyticsService.PROFIT_SQL, 'profit')
      .groupBy(keySql)
      .getRawMany<{
        period_key: string;
        orders_count: string;
        revenue: string;
        profit?: string;
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
      profit: number;
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
        profit: Number(row?.profit ?? 0),
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
        profit: Number(row.profit ?? 0),
      });
    }
    buckets.sort((a, b) => a.period.localeCompare(b.period));

    const totalRevenue = buckets.reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = buckets.reduce((sum, row) => sum + row.ordersCount, 0);
    const totalProfit = buckets.reduce((sum, row) => sum + row.profit, 0);
    const avgRevenue = buckets.length
      ? Math.round(totalRevenue / buckets.length)
      : 0;

    return {
      data: buckets,
      summary: {
        totalRevenue,
        totalOrders,
        avgRevenue,
        totalProfit,
      },
      applied_range,
    };
  }
  /** (DwrMygfo) Dashboard/KPI sparkline uzunligi (kun). */
  private static readonly TREND_SERIES_DAYS = 14;

  /**
   * (DwrMygfo) Dashboard va KPI uchun «oldingi davr» va 14 kunlik kunlik
   * seriya — BITTA RPC (FE ikkinchi og'ir `analytics/dashboard` so'rovini
   * yubormasin).
   *
   * - `previous`: joriy oynadan OLDINGI teng uzunlikdagi oyna (masalan
   *   «Bugun» → kecha, 7 kun → oldingi 7 kun) bo'yicha overview
   *   (`getOverviewStats` — AYNI formulalar) va yetkazish agregati
   *   (`getFulfillmentStats`). `all=true` («Barchasi») — `null` (oldingi
   *   davr yo'q).
   * - `series`: joriy oyna oxiri tushgan Toshkent kuni bilan tugaydigan
   *   oxirgi 14 kun, har kun (bo'sh kun ham 0 bilan): qabul qilingan
   *   (`createdAt`), sotilgan/tushum/foyda (`sold_at`), bekor soni/summasi
   *   (kuzatuv `created_at`, buyurtma bo'yicha DISTINCT), yetkazish
   *   (`createdAt` kuni). Har bir kesim — bitta GROUP BY.
   */
  async getDashboardTrend(input: {
    startDate?: string;
    endDate?: string;
    branch_id?: string;
    all?: boolean;
  }) {
    const all = input.all === true;
    const branchId = input.branch_id || undefined;
    const current = this.analyticsDateRange(
      input.startDate,
      input.endDate,
      all,
    );
    const DAY = 24 * 60 * 60 * 1000;
    const days = OrderAnalyticsService.TREND_SERIES_DAYS;
    const seriesStart = new Date(
      this.periodStart(current.end, 'daily').getTime() - (days - 1) * DAY,
    );
    const seriesRange = { start: seriesStart, end: current.end };

    const previousRange = all
      ? null
      : (() => {
          const length = current.end.getTime() - current.start.getTime() + 1;
          const to = new Date(current.start.getTime() - 1);
          const from = new Date(to.getTime() - length + 1);
          return { from: from.toISOString(), to: to.toISOString() };
        })();

    const dayKey = (column: string) =>
      `to_char(date_trunc('day', ${column} AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD')`;
    const soldKey = this.tashkentPeriodKeySql('daily');
    const deliveryMs = OrderAnalyticsService.FULFILLMENT_DELIVERY_MS_SQL;

    const [
      previousOverview,
      previousFulfillment,
      acceptedRows,
      soldRows,
      cancelledRows,
      fulfillmentRows,
    ] = await Promise.all([
      previousRange
        ? this.getOverviewStats(previousRange.from, previousRange.to, branchId)
        : Promise.resolve(null),
      previousRange
        ? this.getFulfillmentStats(
            previousRange.from,
            previousRange.to,
            branchId,
          )
        : Promise.resolve(null),
      this.applyAnalyticsBranchScope(
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.createdAt BETWEEN :start AND :end', seriesRange),
        branchId,
      )
        .select(dayKey('o.createdAt'), 'day')
        .addSelect('COUNT(*)', 'accepted')
        .groupBy(dayKey('o.createdAt'))
        .getRawMany<{ day: string; accepted: string }>(),
      this.applyAnalyticsBranchScope(
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.status IN (:...statuses)', {
            statuses: this.soldStatuses(),
          })
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
            startMs: String(seriesRange.start.getTime()),
            endMs: String(seriesRange.end.getTime()),
          }),
        branchId,
      )
        .select(soldKey, 'day')
        .addSelect('COUNT(*)', 'sold')
        .addSelect('COALESCE(SUM(o.total_price), 0)', 'revenue')
        .addSelect(OrderAnalyticsService.PROFIT_SQL, 'profit')
        .groupBy(soldKey)
        .getRawMany<{
          day: string;
          sold: string;
          revenue: string;
          profit: string;
        }>(),
      this.historicallyCancelledTrackingQuery(seriesRange, branchId)
        .select(dayKey('t.created_at'), 'day')
        .addSelect('COUNT(DISTINCT t.order_id)', 'cancelled')
        .addSelect(OrderAnalyticsService.LOST_REVENUE_SQL, 'lost')
        .groupBy(dayKey('t.created_at'))
        .getRawMany<{ day: string; cancelled: string; lost: string }>(),
      this.fulfillmentBaseQuery(seriesRange.start, seriesRange.end, branchId)
        .select(dayKey('o.createdAt'), 'day')
        .addSelect('COUNT(*)', 'delivered')
        .addSelect(
          `COALESCE(SUM(${deliveryMs}), 0)::float8`,
          'delivery_ms_total',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE ${deliveryMs} <= :fulfillmentSlaMs)`,
          'on_time',
        )
        .setParameter(
          'fulfillmentSlaMs',
          OrderAnalyticsService.FULFILLMENT_SLA_MS,
        )
        .groupBy(dayKey('o.createdAt'))
        .getRawMany<{
          day: string;
          delivered: string;
          delivery_ms_total: string;
          on_time: string;
        }>(),
    ]);

    const num = (value: unknown) => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const byDay = <T extends { day: string }>(rows: T[] | undefined) =>
      new Map((rows ?? []).map((row) => [String(row.day), row]));
    const accepted = byDay(acceptedRows);
    const sold = byDay(soldRows);
    const cancelled = byDay(cancelledRows);
    const fulfillment = byDay(fulfillmentRows);

    const series = Array.from({ length: days }, (_, index) => {
      const date = this.dateKey(new Date(seriesStart.getTime() + index * DAY));
      const s = sold.get(date);
      const c = cancelled.get(date);
      const f = fulfillment.get(date);
      return {
        date,
        acceptedCount: num(accepted.get(date)?.accepted),
        soldAndPaid: num(s?.sold),
        totalRevenue: num(s?.revenue),
        profit: num(s?.profit),
        cancelled: num(c?.cancelled),
        lostRevenue: num(c?.lost),
        deliveredCount: num(f?.delivered),
        deliveryMsTotal: num(f?.delivery_ms_total),
        onTimeCount: num(f?.on_time),
      };
    });

    return {
      previous:
        previousRange && previousOverview
          ? {
              from: previousRange.from,
              to: previousRange.to,
              acceptedCount: previousOverview.acceptedCount,
              soldAndPaid: previousOverview.soldAndPaid,
              cancelled: previousOverview.cancelled,
              lostRevenue: previousOverview.lostRevenue,
              totalRevenue: previousOverview.totalRevenue,
              profit: previousOverview.profit,
              deliveredCount: previousFulfillment?.deliveredCount ?? 0,
              deliveryMsTotal: previousFulfillment?.deliveryMsTotal ?? 0,
              onTimeCount: previousFulfillment?.onTimeCount ?? 0,
            }
          : null,
      series,
      series_days: days,
      series_from: seriesStart.toISOString(),
      series_to: current.end.toISOString(),
    };
  }
}
