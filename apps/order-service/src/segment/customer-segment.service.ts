import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order_status } from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Order } from '../entities/order.entity';

/**
 * hiqRNhkI: telefon bo'yicha mijoz taklifi — mijozning SHU MARKETdagi
 * buyurtmalari xulosasi. Gateway (`GET /customers/suggest`) uni ikki maqsadda
 * ishlatadi:
 *   1) market / market operatori / filial xodimi faqat shu marketda buyurtmasi
 *      bo'lgan mijozlarni ko'radi (boshqa marketlar mijozlarining ism/manzili
 *      oqib chiqmasin — fix3 RBAC-01 bilan bir xil tamoyil);
 *   2) "Diqqat! Bu mijozda yangi holatdagi buyurtma bor" ogohlantirishi —
 *      takroriy buyurtmadan saqlaydi (BeePost customer-info hasNewOrders).
 */
export interface CustomerMarketSummaryInput {
  market_id?: string | null;
  customer_ids?: unknown[] | null;
}

export interface CustomerMarketSummaryItem {
  customer_id: string;
  orders: number;
  /** Hali olib ketilmagan (`created` / `new`) buyurtmalar soni. */
  new_orders: number;
  /** Eng yangi `created`/`new` buyurtmalar id'lari (ko'pi bilan 5 ta). */
  new_order_ids: string[];
  last_order_at: Date | null;
}

/** Bitta so'rovda ko'pi bilan shuncha mijoz (gateway taklif nomzodlari). */
export const CUSTOMER_MARKET_SUMMARY_MAX_IDS = 100;
const NEW_ORDER_STATUSES = [Order_status.CREATED, Order_status.NEW];
const NEW_ORDER_IDS_LIMIT = 5;

export interface CustomerSegmentFilter {
  market_id?: string | null;
  region_id?: string | null;
  district_id?: string | null;
  /** Oxirgi buyurtma shu sanadan keyin (YYYY-MM-DD yoki ISO). */
  last_order_from?: string | null;
  /** Oxirgi buyurtma shu sanadan oldin — "uxlab qolgan" mijozlar. */
  last_order_to?: string | null;
  min_orders?: number | null;
  /** (ebSV5oyP) Buyurtmalar soni oralig'i — yuqori chegara (kiradi). */
  max_orders?: number | null;
  limit?: number | null;
}

const ID_RE = /^\d+$/;
const MAX_LIMIT = 5000;

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Reklama kampaniyasi uchun MIJOZ segmenti (sVByLMnt #5): buyurtmalar bo'yicha
 * (market, hudud, oxirgi buyurtma sanasi, buyurtmalar soni). identity'ning
 * `find_all` iga TEGILMAYDI — u yerdagi rol filtri boshqa joylarda himoya.
 * Natija — mijoz id'lari; telefonlar notification-service'da identity'dan.
 */
@Injectable()
export class CustomerSegmentService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
  ) {}

  async find(filter: CustomerSegmentFilter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), MAX_LIMIT);
    const query = this.orders
      .createQueryBuilder('o')
      .select('o.customer_id', 'customer_id')
      .addSelect('COUNT(*)::int', 'orders')
      .addSelect('MAX(o.createdAt)', 'last_order_at')
      .where('o.customer_id IS NOT NULL')
      .groupBy('o.customer_id');

    for (const key of ['market_id', 'region_id', 'district_id'] as const) {
      const value = filter[key];
      if (value !== undefined && value !== null && value !== '') {
        if (!ID_RE.test(String(value))) throw new Error(`${key} noto'g'ri`);
        query.andWhere(`o.${key} = :${key}`, { [key]: String(value) });
      }
    }
    const minOrders = Number(filter.min_orders);
    if (Number.isFinite(minOrders) && minOrders > 1) {
      query.having('COUNT(*) >= :minOrders', { minOrders });
    }
    const maxOrders = Number(filter.max_orders);
    if (Number.isInteger(maxOrders) && maxOrders >= 1) {
      query.andHaving('COUNT(*) <= :maxOrders', { maxOrders });
    }
    const from = parseDate(filter.last_order_from);
    if (from) query.andHaving('MAX(o.createdAt) >= :from', { from });
    const to = parseDate(filter.last_order_to);
    if (to) query.andHaving('MAX(o.createdAt) < :to', { to });

    const rows: Array<{
      customer_id: string;
      orders: number;
      last_order_at: Date;
    }> = await query
      .orderBy('MAX(o.createdAt)', 'DESC')
      .limit(limit + 1)
      .getRawMany();

    return successRes({
      items: rows.slice(0, limit).map((row) => ({
        customer_id: String(row.customer_id),
        orders: Number(row.orders),
        last_order_at: row.last_order_at,
      })),
      // Chegaradan ko'p — chaqiruvchi XATO qiladi, jimgina kesmaydi.
      truncated: rows.length > limit,
      limit,
    });
  }

  /**
   * hiqRNhkI: `customer_ids` ning SHU marketdagi buyurtma xulosasi. Marketda
   * buyurtmasi yo'q mijoz natijada UMUMAN bo'lmaydi (gateway uni taklifdan
   * chiqaradi). O'chirilgan buyurtmalar hisobga olinmaydi.
   */
  async marketSummary(input: CustomerMarketSummaryInput = {}) {
    const marketId = String(input?.market_id ?? '').trim();
    if (!ID_RE.test(marketId)) {
      throw new RpcException({
        statusCode: 400,
        message: "market_id noto'g'ri",
      });
    }
    const ids = [
      ...new Set(
        (Array.isArray(input?.customer_ids) ? input.customer_ids : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number'
              ? String(id).trim()
              : '',
          )
          .filter((id) => ID_RE.test(id)),
      ),
    ];
    if (ids.length > CUSTOMER_MARKET_SUMMARY_MAX_IDS) {
      throw new RpcException({
        statusCode: 400,
        message: `customer_ids ko'pi bilan ${CUSTOMER_MARKET_SUMMARY_MAX_IDS} ta`,
      });
    }
    if (!ids.length) {
      return successRes({ items: [] as CustomerMarketSummaryItem[] });
    }

    const rows: Array<{
      customer_id: string;
      orders: number;
      new_orders: number;
      new_order_ids: Array<string | number> | null;
      last_order_at: Date | null;
    }> = await this.orders
      .createQueryBuilder('o')
      .select('o.customer_id', 'customer_id')
      .addSelect('COUNT(*)::int', 'orders')
      .addSelect(
        'COUNT(*) FILTER (WHERE o.status IN (:...newStatuses))::int',
        'new_orders',
      )
      .addSelect(
        'array_remove(array_agg(CASE WHEN o.status IN (:...newStatuses) THEN o.id END ORDER BY o.id DESC), NULL)',
        'new_order_ids',
      )
      .addSelect('MAX(o.createdAt)', 'last_order_at')
      .where('o.market_id = :marketId', { marketId })
      .andWhere('o.customer_id IN (:...ids)', { ids })
      .andWhere('o.isDeleted = :isDeleted', { isDeleted: false })
      .setParameter('newStatuses', NEW_ORDER_STATUSES)
      .groupBy('o.customer_id')
      .getRawMany();

    return successRes({
      items: rows.map(
        (row): CustomerMarketSummaryItem => ({
          customer_id: String(row.customer_id),
          orders: Number(row.orders) || 0,
          new_orders: Number(row.new_orders) || 0,
          new_order_ids: (row.new_order_ids ?? [])
            .slice(0, NEW_ORDER_IDS_LIMIT)
            .map((id) => String(id)),
          last_order_at: row.last_order_at ?? null,
        }),
      ),
    });
  }
}
