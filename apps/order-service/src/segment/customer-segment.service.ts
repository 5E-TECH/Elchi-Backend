import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { successRes } from '../../../../libs/common/helpers/response';
import { Order } from '../entities/order.entity';

export interface CustomerSegmentFilter {
  market_id?: string | null;
  region_id?: string | null;
  district_id?: string | null;
  /** Oxirgi buyurtma shu sanadan keyin (YYYY-MM-DD yoki ISO). */
  last_order_from?: string | null;
  /** Oxirgi buyurtma shu sanadan oldin — "uxlab qolgan" mijozlar. */
  last_order_to?: string | null;
  min_orders?: number | null;
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
}
