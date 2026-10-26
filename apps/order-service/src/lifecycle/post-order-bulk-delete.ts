import { BranchTransferBatchStatus, Order_status } from '@app/common';
import { OrderHolderType } from '../entities/order.entity';

/**
 * yokjwjXG — superadmin pochta detalidagi "savat": buyurtmalarni SHU
 * POCHTADAN o'chirish (`POST /post/delete` → `order.post.delete_orders`).
 *
 * Bu fayl — sof (I/O'siz) qismlar: kirishni tekshirish, qatorlarni
 * "o'chiriladi / o'tkazib yuboriladi / to'sildi" ga ajratish va 409 xabarini
 * yig'ish. Tranzaksiya `OrderLifecycleService.deleteOrdersFromPost` da.
 *
 * ⚠️ BU BEKOR QILISH EMAS. `POST /post/cancel` (kuryer/menejer qaytarish
 * oqimi) buyurtmani CANCELLED_SENT qiladi — bu yerda esa buyurtma tizimdan
 * soft-delete qilinadi. "Buyurtmani qoldirib faqat pochtadan chiqarish"
 * ISHLAMAYDI: logistics `newPosts()` pochtasiz RECEIVED HQ buyurtmalarni
 * keyingi yuklashda qayta pochtaga qo'shadi.
 */

export const POST_ORDER_DELETE_MAX_ORDERS = 100;
export const POST_ORDER_DELETE_REASON_MIN = 3;
export const POST_ORDER_DELETE_REASON_MAX = 500;

/**
 * O'chirishga ruxsat etilgan holatlar — hali hech kimga topshirilmagan,
 * pul tegmagan bosqichlar. NEW pochtada amalda faqat `received` bo'ladi;
 * qolgan holat (yo'lda, sotilgan, bekor...) chiqsa bu ma'lumot anomaliyasi
 * va jimgina o'chirilmaydi.
 */
export const POST_ORDER_DELETE_ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  Order_status.CREATED,
  Order_status.NEW,
  Order_status.RECEIVED,
]);

export type PostOrderDeleteBlockReason =
  | 'not_found'
  | 'not_in_post'
  | 'status'
  | 'courier_holds'
  | 'sold'
  | 'canceled_post'
  | 'return_requested'
  | 'cash_collected'
  | 'batch_in_transit';

export const POST_ORDER_DELETE_BLOCK_REASON_UZ: Record<
  PostOrderDeleteBlockReason,
  string
> = {
  not_found: 'topilmadi',
  not_in_post: 'bu pochtaga tegishli emas',
  status: "holati o'chirishga mos emas",
  courier_holds: "kuryer qo'lida",
  sold: 'sotilgan',
  canceled_post: 'bekor qilingan pochtada',
  return_requested: "qaytarish so'ralgan",
  cash_collected: "naqd pul yig'ilgan (paid_amount > 0)",
  batch_in_transit: "filiallararo partiyada yo'lda",
};

export interface PostOrderDeleteInput {
  postId: string;
  orderIds: string[];
  reason: string;
}

/** `orders` qatori — FOR UPDATE bilan qulflab o'qilgan ustunlar. */
export interface LockedPostOrderRow {
  id: string;
  post_id: string | null;
  status: string;
  is_deleted: boolean;
  deleted_at: Date | string | null;
  holder_type: string | null;
  sold_at: string | null;
  canceled_post_id: string | null;
  return_requested: boolean;
  paid_amount: number | string | null;
  paid_online_amount: number | string | null;
  payment_status: string | null;
  current_batch_id: string | null;
  total_price: number | string | null;
  extra_cost: number | string | null;
  market_id: string | null;
  source: string | null;
  external_id: string | null;
  operator: string | null;
  /** VkKDSNNn: `WAREHOUSE` bo'lsa o'chirishda ombor bandi bo'shatiladi. */
  fulfillment_source?: string | null;
}

/** `logistics_schema.posts` qatori — FOR UPDATE bilan qulflangan. */
export interface LockedPostRow {
  id: string;
  status: string;
  qr_code_token: string | null;
  region_id: string | null;
  courier_id: string | null;
  branch_id: string | null;
  order_quantity: number | string | null;
  post_total_price: number | string | null;
}

/** Tranzaksiya natijasi (jurnal va javob shundan yig'iladi). */
export interface PostOrderDeleteOutcome {
  deletedRows: LockedPostOrderRow[];
  skipped: string[];
  postDeleted: boolean;
  orderQuantity: number;
  postTotalPrice: number;
  postBefore: {
    status: string;
    order_quantity: number;
    post_total_price: number;
  } | null;
  /** Buyurtma chiqarilgan PENDING partiyalar. */
  touchedBatchIds: string[];
}

export interface PostOrderDeleteBlocked {
  id: string;
  reason: PostOrderDeleteBlockReason;
  detail?: string;
}

export interface PostOrderDeletePlan {
  toDelete: LockedPostOrderRow[];
  skipped: string[];
  blocked: PostOrderDeleteBlocked[];
}

const POSITIVE_ID = /^[1-9]\d{0,18}$/;

/** Musbat butun son satri (bigint) — boshqa hamma narsa `null`. */
export function normalizePositiveId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  return POSITIVE_ID.test(raw) ? raw : null;
}

/**
 * Gateway DTO bilan AYNI qoidalar — order-service RMQ'dan to'g'ridan-to'g'ri
 * chaqirilsa ham (masalan boshqa servis) himoya shu yerda qayta ishlaydi.
 */
export function parsePostOrderDeleteInput(input: {
  post_id?: unknown;
  order_ids?: unknown;
  reason?: unknown;
}): PostOrderDeleteInput | { error: string } {
  const postId = normalizePositiveId(input?.post_id);
  if (!postId) {
    return { error: "post_id musbat butun son bo'lishi kerak" };
  }
  if (!Array.isArray(input?.order_ids) || !input.order_ids.length) {
    return { error: "order_ids bo'sh bo'lmasligi kerak" };
  }
  if (input.order_ids.length > POST_ORDER_DELETE_MAX_ORDERS) {
    return {
      error: `Bir so'rovda ko'pi bilan ${POST_ORDER_DELETE_MAX_ORDERS} ta buyurtma o'chiriladi`,
    };
  }
  const orderIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.order_ids as unknown[]) {
    const id = normalizePositiveId(raw);
    if (!id) {
      return { error: "order_ids ichida faqat musbat butun son bo'ladi" };
    }
    if (seen.has(id)) {
      return { error: `order_ids takrorlangan: ${id}` };
    }
    seen.add(id);
    orderIds.push(id);
  }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (
    reason.length < POST_ORDER_DELETE_REASON_MIN ||
    reason.length > POST_ORDER_DELETE_REASON_MAX
  ) {
    return {
      error: `Sabab (reason) ${POST_ORDER_DELETE_REASON_MIN}–${POST_ORDER_DELETE_REASON_MAX} belgi bo'lishi kerak`,
    };
  }
  return { postId, orderIds, reason };
}

export function isOrderRowDeleted(row: LockedPostOrderRow): boolean {
  return row.is_deleted === true || row.deleted_at != null;
}

function money(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * So'ralgan id'larni uch guruhga ajratadi. Tartib so'rov tartibida.
 *
 * - allaqachon o'chirilgan → `skipped` (idempotent takror, xato emas);
 * - jismoniy/pul cheklovi buzilgan → `blocked` (hammasi-yoki-hech biri: bitta
 *   blok bo'lsa ham hech narsa o'zgarmaydi);
 * - qolgani → `toDelete`.
 *
 * Hamkor buyurtmasi, partiya (PENDING) va onlayn oldindan to'lov TO'SIQ EMAS —
 * ularning yon ta'siri tranzaksiyada to'g'rilanadi (Dilshod 2026-10-15:
 * "superadmin pochtadagi ISTALGAN buyurtmani o'chira olsin").
 */
export function classifyPostOrders(
  postId: string,
  requestedIds: readonly string[],
  rows: readonly LockedPostOrderRow[],
): PostOrderDeletePlan {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const plan: PostOrderDeletePlan = { toDelete: [], skipped: [], blocked: [] };

  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) {
      plan.blocked.push({ id, reason: 'not_found' });
      continue;
    }
    if (isOrderRowDeleted(row)) {
      plan.skipped.push(id);
      continue;
    }
    if (String(row.post_id ?? '') !== postId) {
      plan.blocked.push({ id, reason: 'not_in_post' });
      continue;
    }
    if (!POST_ORDER_DELETE_ALLOWED_STATUSES.has(String(row.status))) {
      plan.blocked.push({ id, reason: 'status', detail: String(row.status) });
      continue;
    }
    if (row.holder_type === OrderHolderType.COURIER) {
      plan.blocked.push({ id, reason: 'courier_holds' });
      continue;
    }
    if (row.sold_at) {
      plan.blocked.push({ id, reason: 'sold' });
      continue;
    }
    if (row.canceled_post_id) {
      plan.blocked.push({ id, reason: 'canceled_post' });
      continue;
    }
    if (row.return_requested) {
      plan.blocked.push({ id, reason: 'return_requested' });
      continue;
    }
    if (money(row.paid_amount) !== 0) {
      plan.blocked.push({ id, reason: 'cash_collected' });
      continue;
    }
    plan.toDelete.push(row);
  }
  return plan;
}

/** Partiya qatori — FOR UPDATE bilan qulflangan. */
export interface LockedBatchRow {
  id: string;
  status: string;
}

export interface LockedBatchItemRow {
  batch_id: string;
  order_id: string;
  sent_at: Date | string | null;
}

/**
 * Partiya to'siqlari: jo'natilgan (`SENT`) partiya yoki jo'natilgan item —
 * posilka jismonan yo'lda, uni "o'chirib" bo'lmaydi. `PENDING` partiyadan
 * buyurtma chiqariladi; `RECEIVED`/`CANCELLED` (yoki topilmagan) partiyaga
 * ko'rsatgich esa eskirgan — faqat `current_batch_id` tozalanadi.
 */
export function classifyBatchBlockers(
  orders: readonly LockedPostOrderRow[],
  batches: readonly LockedBatchRow[],
  items: readonly LockedBatchItemRow[],
): { blocked: PostOrderDeleteBlocked[]; pendingBatchIds: string[] } {
  const batchById = new Map(batches.map((batch) => [String(batch.id), batch]));
  const sentItem = new Set(
    items
      .filter((item) => item.sent_at != null)
      .map((item) => `${item.batch_id}:${item.order_id}`),
  );
  const blocked: PostOrderDeleteBlocked[] = [];
  const pending = new Set<string>();
  for (const order of orders) {
    const batchId = String(order.current_batch_id ?? '').trim();
    if (!batchId) continue;
    const batch = batchById.get(batchId);
    if (!batch) continue;
    if (
      batch.status === BranchTransferBatchStatus.SENT ||
      sentItem.has(`${batchId}:${order.id}`)
    ) {
      blocked.push({
        id: String(order.id),
        reason: 'batch_in_transit',
        detail: batchId,
      });
      continue;
    }
    if (batch.status === BranchTransferBatchStatus.PENDING) {
      pending.add(batchId);
    }
  }
  return { blocked, pendingBatchIds: [...pending].sort() };
}

/**
 * 409 xabari. Gateway `AllExceptionsFilter` faqat `message` ni qaytaradi,
 * shuning uchun qaysi id va nima sababi MATNNING o'zida bo'lishi shart.
 */
export function describePostOrderDeleteBlocked(
  blocked: readonly PostOrderDeleteBlocked[],
): string {
  const shown = blocked.slice(0, 20).map((item) => {
    const base = POST_ORDER_DELETE_BLOCK_REASON_UZ[item.reason];
    const suffix =
      item.reason === 'status' && item.detail ? ` (${item.detail})` : '';
    return `#${item.id} — ${base}${suffix}`;
  });
  const more =
    blocked.length > shown.length
      ? `; yana ${blocked.length - shown.length} ta`
      : '';
  return (
    `${blocked.length} ta buyurtmani pochtadan o'chirib bo'lmaydi: ` +
    `${shown.join('; ')}${more}. Hech narsa o'zgarmadi`
  );
}

/**
 * TypeORM 0.3 `manager.query()` postgres'da UPDATE/DELETE uchun
 * `[rows, rowCount]` qaytaradi (SELECT uchun esa faqat `rows`). Ikkala
 * shaklni ham qatorlar massiviga keltiradi.
 */
export function returnedRows<T>(raw: unknown): T[] {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    Array.isArray(raw[0]) &&
    typeof raw[1] === 'number'
  ) {
    return raw[0] as T[];
  }
  return Array.isArray(raw) ? (raw as T[]) : [];
}
