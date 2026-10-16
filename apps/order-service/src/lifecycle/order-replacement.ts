import { RpcException } from '@nestjs/microservices';
import { In, type EntityManager } from 'typeorm';
import { Order_status } from '@app/common';
import { Order, OrderReplacementState } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/**
 * lQjt6sKP — ALMASHTIRISH (kafolat-swap) oqimi.
 *
 * Yangi buyurtma avval YETKAZILGAN eski buyurtma o'rniga ketadi: kuryer
 * yangisini topshirib, eski mahsulotni mijozdan qaytarib oladi (BeePost
 * `createOrder` + `sellOrder` gate modeli).
 *
 * ⚠️ PUL: eski buyurtmaning statusi (SOTILGAN) va pul ustunlari / kassa /
 * settlement yozuvlari O'ZGARMAYDI — reversal yo'q. Bu modul faqat
 * `replacement_*`, `is_replacement_return`, `old_item_collected_at`
 * ustunlariga yozadi. Yangi buyurtma oddiy sotuv yo'lidan o'tadi.
 */

/**
 * Almashtirishga tanlash mumkin bo'lgan (YETKAZILGAN) holatlar — analitika
 * `soldStatuses()` bilan AYNI. `CLOSED` EMAS: Elchida u bekor zanjirining
 * oxiri (mahsulot mijozga yetib bormagan) — BeePost ham uni chiqargan.
 */
export const REPLACEABLE_ORDER_STATUSES: readonly Order_status[] = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
];

const ID_RE = /^\d{1,18}$/;

function badRequest(message: string): never {
  throw new RpcException({ statusCode: 400, message });
}

/**
 * `replaced_order_id` → toza id yoki `null` (berilmagan / bo'sh). Noto'g'ri
 * shakl — 400 (ValidationPipe'dan o'tmaydigan ichki chaqiruvlar uchun ham).
 */
export function normalizeReplacedOrderId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    badRequest("replaced_order_id noto'g'ri — buyurtma raqami (ID) kerak");
  }
  const id = String(value).trim();
  if (!id) return null;
  if (!ID_RE.test(id) || /^0+$/.test(id)) {
    badRequest("replaced_order_id noto'g'ri — buyurtma raqami (ID) kerak");
  }
  return id;
}

/**
 * Kuryerning "eskisini oldim" tasdig'i. Sotuv `multipart/form-data` bilan
 * ham keladi, shuning uchun `'true'` / `'1'` satrlari ham qabul qilinadi.
 */
export function parseOldItemCollectedFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1';
  }
  return false;
}

/**
 * YARATISH (tranzaksiya ichida, yangi buyurtma INSERT'dan OLDIN): eski
 * buyurtmani `FOR UPDATE` bilan qulflab, BeePost'dagi 4 tekshiruv:
 *   1. shu marketga tegishli (topilmasa ham AYNI xabar — boshqa market
 *      buyurtmasi borligi oshkor bo'lmaydi);
 *   2. yetkazilgan (`REPLACEABLE_ORDER_STATUSES`);
 *   3. hali faol almashtirishi yo'q (o'chirilmagan bog'lanish);
 *   4. qulf — ikki parallel yaratish ketma-ket bajariladi, ikkinchisi 3-band
 *      bo'yicha 400 oladi. DB'dagi `UQ_ORDER_REPLACEMENT_OF` — oxirgi to'siq.
 */
export async function lockAndAssertReplaceableOrder(
  tx: EntityManager,
  input: { replacedOrderId: string; marketId: string | null | undefined },
): Promise<Order> {
  const repo = tx.getRepository(Order);
  const old = await repo.findOne({
    where: { id: input.replacedOrderId, isDeleted: false },
    lock: { mode: 'pessimistic_write' },
  });
  const marketId = String(input.marketId ?? '').trim();
  if (!old || !marketId || String(old.market_id) !== marketId) {
    badRequest(
      `Almashtiriladigan buyurtma #${input.replacedOrderId} shu marketda topilmadi — ` +
        'faqat shu marketning yetkazilgan buyurtmasini tanlash mumkin',
    );
  }
  if (!REPLACEABLE_ORDER_STATUSES.includes(old.status)) {
    badRequest(
      `Faqat yetkazib berilgan (sotilgan) buyurtmani almashtirish mumkin — ` +
        `#${old.id} holati: ${old.status}`,
    );
  }
  const existing = await repo.findOne({
    where: { replacement_of_order_id: String(old.id), isDeleted: false },
    withDeleted: true,
    select: { id: true },
  });
  if (existing) {
    badRequest(
      `Bu buyurtma (#${old.id}) allaqachon almashtirishga belgilangan — ` +
        `almashtirish buyurtmasi #${existing.id}`,
    );
  }
  return old;
}

/**
 * YARATISH (o'sha tranzaksiyada): eski buyurtmani jismoniy qaytarish uchun
 * belgilash. FAQAT bayroq va holat — status, summa, tarif, settlement
 * ustunlariga TEGILMAYDI.
 */
export async function markOrderForReplacementReturn(
  tx: EntityManager,
  oldOrderId: string,
): Promise<void> {
  await tx.getRepository(Order).update(
    { id: String(oldOrderId) },
    {
      is_replacement_return: true,
      replacement_state: OrderReplacementState.AWAITING_OLD_PICKUP,
      old_item_collected_at: null,
    },
  );
}

/**
 * SOTUV DARVOZASI (pul yozilishidan va tasdiq so'rovidan OLDIN).
 * Almashtirish buyurtmasini sotish uchun kuryer eski mahsulotni olganini
 * tasdiqlashi SHART (`old_item_collected: true`), yoki u allaqachon
 * tasdiqlangan bo'lishi kerak (masalan rollback'dan keyin qayta sotuv).
 * Qaytaradi: buyurtma almashtirishmi (tranzaksiyada holat yoziladimi).
 */
export function assertReplacementSaleAllowed(
  order: Pick<Order, 'replacement_of_order_id' | 'replacement_state'>,
  oldItemCollected: unknown,
): boolean {
  if (!order.replacement_of_order_id) return false;
  const alreadyCollected =
    order.replacement_state === OrderReplacementState.OLD_COLLECTED ||
    order.replacement_state === OrderReplacementState.OLD_RETURNED;
  if (!alreadyCollected && !parseOldItemCollectedFlag(oldItemCollected)) {
    badRequest(
      `Bu almashtirish buyurtmasi (eski #${order.replacement_of_order_id} o'rniga). ` +
        'Avval eski mahsulotni mijozdan olganingizni tasdiqlang ' +
        '("Eskisini oldim", old_item_collected: true) — tasdiqsiz sotib bo\'lmaydi',
    );
  }
  return true;
}

/**
 * SOTUV TRANZAKSIYASIDA (`updateFull` dan KEYIN — u butun entity'ni saqlaydi):
 * yangi va eski buyurtmada `awaiting_old_pickup → old_collected`. Eski
 * buyurtma faqat hali shu almashtirishning qaytishi bo'lsa yangilanadi.
 * Pul ustunlariga TEGILMAYDI.
 */
export async function markReplacementOldItemCollected(
  tx: EntityManager,
  order: Pick<Order, 'id' | 'replacement_of_order_id'>,
): Promise<void> {
  if (!order.replacement_of_order_id) return;
  await tx
    .createQueryBuilder()
    .update(Order)
    .set({
      replacement_state: OrderReplacementState.OLD_COLLECTED,
      old_item_collected_at: new Date(),
    })
    .where('replacement_state = :awaiting', {
      awaiting: OrderReplacementState.AWAITING_OLD_PICKUP,
    })
    .andWhere(
      '(id = :newId OR (id = :oldId AND is_replacement_return = true))',
      {
        newId: String(order.id),
        oldId: String(order.replacement_of_order_id),
      },
    )
    .execute();
}

// ---------------------------------------------------------------------------
// RO'YXATLAR (faqat o'qish)
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;

function clampPage(page: unknown): number {
  const n = Math.trunc(Number(page));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function clampLimit(limit: unknown, fallback = 20): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ReplaceableOrdersQuery {
  market_id?: string | null;
  customer_id?: string | null;
  /** Gateway telefon bo'yicha topgan mijozlar (shu doirada). */
  customer_ids?: string[] | null;
  /** Raqam — buyurtma ID; matn — izoh yoki mahsulot nomi. */
  q?: string | null;
  page?: number | string;
  limit?: number | string;
}

export interface ReplacementOrderRow {
  id: string;
  status: Order_status;
  market_id: string;
  customer_id: string;
  total_price: number;
  where_deliver: string;
  comment: string | null;
  sold_at: string | null;
  createdAt: Date;
  items: Array<{
    product_id: string | null;
    product_name: string | null;
    quantity: number;
  }>;
}

function toRow(order: Order): ReplacementOrderRow {
  return {
    id: String(order.id),
    status: order.status,
    market_id: String(order.market_id),
    customer_id: String(order.customer_id),
    total_price: Number(order.total_price ?? 0),
    where_deliver: String(order.where_deliver ?? ''),
    comment: order.comment ?? null,
    sold_at: order.sold_at ?? null,
    createdAt: order.createdAt,
    items: (order.items ?? []).map((item) => ({
      product_id: item.product_id ? String(item.product_id) : null,
      product_name: item.product_name ?? null,
      quantity: Number(item.quantity ?? 0),
    })),
  };
}

/**
 * `GET /orders/replaceable` — almashtirishga TANLASH MUMKIN bo'lgan
 * buyurtmalar: shu market, yetkazilgan (`REPLACEABLE_ORDER_STATUSES`) va
 * hali faol almashtirishi yo'q (`lockAndAssertReplaceableOrder` bilan AYNI
 * qoida — o'chirilgan almashtirish hisobga olinmaydi). Market doirasi
 * gateway'da aniqlanadi; bu yerda `market_id` majburiy.
 */
export async function findReplaceableOrders(
  manager: EntityManager,
  query: ReplaceableOrdersQuery,
): Promise<{
  items: ReplacementOrderRow[];
  total: number;
  page: number;
  limit: number;
}> {
  const marketId = String(query.market_id ?? '').trim();
  if (!ID_RE.test(marketId)) {
    badRequest('market_id majburiy — almashtirish faqat shu market ichida');
  }
  const page = clampPage(query.page);
  const limit = clampLimit(query.limit);

  const qb = manager
    .getRepository(Order)
    .createQueryBuilder('o')
    .leftJoinAndSelect('o.items', 'item')
    .where('o.market_id = :marketId', { marketId })
    .andWhere('o.isDeleted = false')
    .andWhere('o.status IN (:...statuses)', {
      statuses: [...REPLACEABLE_ORDER_STATUSES],
    })
    .andWhere((outer) => {
      const active = outer
        .subQuery()
        .select('1')
        .from(Order, 'r')
        .where('r.replacement_of_order_id = o.id')
        .andWhere('r.isDeleted = false')
        .getQuery();
      return `NOT EXISTS ${active}`;
    });

  const customerId = String(query.customer_id ?? '').trim();
  if (customerId) {
    if (!ID_RE.test(customerId)) badRequest("customer_id noto'g'ri");
    qb.andWhere('o.customer_id = :customerId', { customerId });
  }
  if (Array.isArray(query.customer_ids)) {
    const ids = query.customer_ids
      .map((id) => String(id ?? '').trim())
      .filter((id) => ID_RE.test(id));
    if (!ids.length) {
      return { items: [], total: 0, page, limit };
    }
    qb.andWhere('o.customer_id IN (:...customerIds)', { customerIds: ids });
  }
  const q = String(query.q ?? '').trim();
  if (q) {
    if (ID_RE.test(q)) {
      qb.andWhere('o.id = :qId', { qId: q });
    } else {
      const like = `%${escapeLike(q.slice(0, 100))}%`;
      qb.andWhere(
        (outer) => {
          const itemMatch = outer
            .subQuery()
            .select('1')
            .from(OrderItem, 'qi')
            .where('qi.order_id = o.id')
            .andWhere("qi.product_name ILIKE :like ESCAPE '\\'")
            .getQuery();
          return `(o.comment ILIKE :like ESCAPE '\\' OR EXISTS ${itemMatch})`;
        },
        { like },
      );
    }
  }

  const [orders, total] = await qb
    .orderBy('o.sold_at', 'DESC', 'NULLS LAST')
    .addOrderBy('o.id', 'DESC')
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();

  return { items: orders.map(toRow), total, page, limit };
}

export interface ReplacementReturnsQuery {
  market_id?: string | null;
  state?: string | null;
  page?: number | string;
  limit?: number | string;
}

/**
 * `GET /orders/replacement/returns` — almashtirishga tanlangan ESKI
 * buyurtmalar (mahsuloti qaytarilishi kerak) va ularning o'rniga ketgan
 * yangi buyurtma. Holat: kuryer eskini olganmi (`old_collected`).
 */
export async function findReplacementReturns(
  manager: EntityManager,
  query: ReplacementReturnsQuery,
): Promise<{
  items: Array<
    ReplacementOrderRow & {
      replacement_state: OrderReplacementState | null;
      old_item_collected_at: Date | null;
      replacement_order_id: string | null;
      replacement_order_status: Order_status | null;
    }
  >;
  total: number;
  page: number;
  limit: number;
}> {
  const page = clampPage(query.page);
  const limit = clampLimit(query.limit);
  const qb = manager
    .getRepository(Order)
    .createQueryBuilder('o')
    .leftJoinAndSelect('o.items', 'item')
    .where('o.is_replacement_return = true')
    .andWhere('o.isDeleted = false');

  const marketId = String(query.market_id ?? '').trim();
  if (marketId) {
    if (!ID_RE.test(marketId)) badRequest("market_id noto'g'ri");
    qb.andWhere('o.market_id = :marketId', { marketId });
  }
  const state = String(query.state ?? '').trim();
  if (state) {
    const allowed = Object.values(OrderReplacementState) as string[];
    if (!allowed.includes(state)) {
      badRequest(`state faqat: ${allowed.join(', ')}`);
    }
    qb.andWhere('o.replacement_state = :state', { state });
  }

  const [orders, total] = await qb
    .orderBy('o.updatedAt', 'DESC')
    .addOrderBy('o.id', 'DESC')
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();

  const ids = orders.map((o) => String(o.id));
  const replacements = ids.length
    ? await manager.getRepository(Order).find({
        where: {
          replacement_of_order_id: In(ids),
          isDeleted: false,
        },
        select: { id: true, status: true, replacement_of_order_id: true },
      })
    : [];
  const byOld = new Map(
    replacements.map((r) => [String(r.replacement_of_order_id), r]),
  );

  return {
    items: orders.map((o) => {
      const repl = byOld.get(String(o.id));
      return {
        ...toRow(o),
        replacement_state: o.replacement_state ?? null,
        old_item_collected_at: o.old_item_collected_at ?? null,
        replacement_order_id: repl ? String(repl.id) : null,
        replacement_order_status: repl?.status ?? null,
      };
    }),
    total,
    page,
    limit,
  };
}
