import { Order_status } from '@app/common';
import type { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';

/**
 * 2026-11-20 — ega: «operator nomidan yaratilgan buyurtmalarga xizmat haqqi
 * yozilmayapti va ko'rsatilmayapti».
 *
 * Sabab: veb AI paneli (va qo'lda formada ism yozib qo'yish) buyurtmaga
 * operator ismini faqat MATN qilib yozardi (`orders.operator`), `operator_id`
 * esa bo'sh qolardi — sotuvda komissiya faqat `operator_id` bo'yicha yoziladi.
 * Yangi buyurtmalar uchun tanlov tuzatildi; bu — ESKI buyurtmalarni topish:
 * shu marketda `operator_id` yo'q, lekin operator ismi yozilgan buyurtmalar,
 * ism bo'yicha guruhlab (`#`, harf katta-kichikligi va bo'shliqlar farq
 * qilmaydi). Market guruhga operatorni O'ZI tanlaydi va ommaviy biriktiradi
 * (`order.operator.assign_bulk` → har biri `assignOperator` bilan, sotilgan
 * bo'lsa ulush sotuvdagidek yoziladi). Avtomatik bog'lash YO'Q.
 *
 * Tashqi integratsiya buyurtmalari (`operator = 'external_…'`) — kirmaydi
 * (u matn hamkor holat sinxroni kaliti, biriktirib bo'lmaydi).
 */

/** Bitta guruhda qaytariladigan buyurtma id'lari chegarasi (bir so'rovda biriktiriladigani ham shuncha). */
export const UNLINKED_GROUP_ID_LIMIT = 500;
/** Guruhlar soni chegarasi (eng ko'p buyurtmalisi birinchi). */
export const UNLINKED_GROUP_LIMIT = 200;

export type UnlinkedOperatorGroup = {
  /** Ko'rsatish uchun ism (guruhdagi eng yangi buyurtmadagi yozuv). */
  name: string;
  /** Guruh kaliti — normallashtirilgan ism. */
  key: string;
  total_orders: number;
  /** Sotilgan (sold / paid / partly_paid) — biriktirilsa ulush darhol yoziladi. */
  sold_orders: number;
  /** Eng yangisi birinchi, ko'pi bilan `UNLINKED_GROUP_ID_LIMIT`. */
  order_ids: string[];
};

const SOLD_STATUSES = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
];

/** SQL'dagi guruh kaliti bilan AYNI: `#` boshi olinadi, bo'shliqlar bitta, kichik harf. */
const KEY_SQL = `lower(regexp_replace(btrim(regexp_replace(o.operator, '^\\s*#+', '')), '\\s+', ' ', 'g'))`;

export async function findUnlinkedOperatorGroups(
  orderRepo: Repository<Order>,
  marketId: string,
): Promise<{ groups: UnlinkedOperatorGroup[]; total_orders: number }> {
  const rows = await orderRepo
    .createQueryBuilder('o')
    .select(KEY_SQL, 'key')
    .addSelect(`(array_agg(btrim(o.operator) ORDER BY o.id DESC))[1]`, 'name')
    .addSelect('COUNT(*)', 'total_orders')
    .addSelect(
      `SUM(CASE WHEN o.status IN (:...sold) THEN 1 ELSE 0 END)`,
      'sold_orders',
    )
    .addSelect(
      `(array_agg(o.id::text ORDER BY o.id DESC))[1:${UNLINKED_GROUP_ID_LIMIT}]`,
      'order_ids',
    )
    .where('o.isDeleted = false')
    .andWhere('o.market_id = :marketId', { marketId })
    .andWhere('o.operator_id IS NULL')
    .andWhere('o.operator IS NOT NULL')
    .andWhere(`${KEY_SQL} <> ''`)
    .andWhere(`o.operator NOT LIKE 'external\\_%'`)
    .setParameter('sold', SOLD_STATUSES)
    .groupBy(KEY_SQL)
    .orderBy('total_orders', 'DESC')
    .addOrderBy('key', 'ASC')
    .limit(UNLINKED_GROUP_LIMIT)
    .getRawMany<{
      key: string;
      name: string;
      total_orders: string;
      sold_orders: string;
      order_ids: string[] | null;
    }>();

  const groups = rows.map((row) => ({
    name: String(row.name ?? '').trim(),
    key: String(row.key ?? ''),
    total_orders: Number(row.total_orders) || 0,
    sold_orders: Number(row.sold_orders) || 0,
    order_ids: Array.isArray(row.order_ids) ? row.order_ids.map(String) : [],
  }));
  return {
    groups,
    total_orders: groups.reduce((sum, group) => sum + group.total_orders, 0),
  };
}
