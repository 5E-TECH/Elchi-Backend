import { Order_status } from '@app/common';
import type {
  ExtraCostApprovalAction,
  ExtraCostApprovalItem,
} from '../entities/order-extra-cost-approval.entity';

/**
 * (SPEC v2, 2026-11-12) Kechiktirilgan qo'shimcha xarajat — SOF yordamchilar.
 *
 * Dilshod: «buyurtma joyida sotildi yoki bekor bo'ldi bo'lsin, ortiqcha
 * harajatini o'zi kutilmoqda bo'ladi — alohida tranzaksiya, qaysi tovar
 * uchunligi ko'rinsin». Amal darhol E = 0 bilan bajariladi, E esa alohida
 * `pending` (`mode = 'deferred'`) so'rov bo'lib turadi; tasdiq E ni alohida
 * yozadi, rad etish hech narsa yozmaydi.
 */

/** Sotuv oilasi — tasdiq paytida buyurtma shu holatlardan birida bo'lishi shart. */
export const EXTRA_COST_DEFERRED_SELL_STATUSES: readonly Order_status[] = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
  Order_status.CLOSED,
];

/**
 * Bekor oilasi — CANCELLED va undan keyin buyurtma yetib boradigan har bir
 * bosqich (holat mashinasi: CANCELLED → CANCELLED_SENT / CLOSED /
 * RETURNED_TO_MARKET).
 */
export const EXTRA_COST_DEFERRED_CANCEL_STATUSES: readonly Order_status[] = [
  Order_status.CANCELLED,
  Order_status.CANCELLED_SENT,
  Order_status.CLOSED,
  Order_status.RETURNED_TO_MARKET,
];

export function isDeferredExtraCostFamilyStatus(
  action: ExtraCostApprovalAction,
  status: string | null | undefined,
): boolean {
  const family =
    action === 'cancel'
      ? EXTRA_COST_DEFERRED_CANCEL_STATUSES
      : EXTRA_COST_DEFERRED_SELL_STATUSES;
  return family.includes(String(status ?? '') as Order_status);
}

/**
 * Hamkor (tashqi) buyurtma — `queueExternalStatusSync` /
 * `syncExternalAfterUpdate` uni hamkorga yuboradi (`external_id`). Bunday
 * buyurtmada kechiktirilgan E hamkorga hech qachon yetib bormasdi — eski
 * (replay) yo'l qoladi.
 */
export function isPartnerSyncedOrder(order: {
  external_id?: string | null;
}): boolean {
  return String(order?.external_id ?? '').trim().length > 0;
}

const toId = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim();
  return id ? id : null;
};

/** Sotuv / bekor: buyurtmaning HAMMA qatorlari. */
export function extraCostItemsFromOrderItems(
  items:
    | Array<{
        id?: unknown;
        product_id?: unknown;
        product_name?: string | null;
        quantity?: unknown;
      }>
    | null
    | undefined,
): ExtraCostApprovalItem[] {
  return (items ?? []).map((item) => ({
    order_item_id: toId(item?.id),
    product_id: toId(item?.product_id),
    product_name: item?.product_name ?? null,
    quantity: Math.max(Number(item?.quantity ?? 0) || 0, 0),
  }));
}

/**
 * Qisman sotuv: sotilgan miqdorlar (`sold_quantity`) va qaytganlari
 * (`returned_quantity`). `quantity` — sotilgan miqdor (ro'yxatda shu
 * ko'rinadi); umuman sotilmagan qator ham qoladi (qaytgan bo'lib).
 */
export function extraCostItemsFromPartlySell(
  matches: Array<{
    item: {
      id?: unknown;
      product_id?: unknown;
      product_name?: string | null;
      quantity?: unknown;
    };
    quantity: number;
  }>,
): ExtraCostApprovalItem[] {
  return (matches ?? []).map(({ item, quantity }) => {
    const original = Math.max(Number(item?.quantity ?? 0) || 0, 0);
    const sold = Math.min(Math.max(Number(quantity) || 0, 0), original);
    return {
      order_item_id: toId(item?.id),
      product_id: toId(item?.product_id),
      product_name: item?.product_name ?? null,
      quantity: sold,
      sold_quantity: sold,
      returned_quantity: Math.max(original - sold, 0),
    };
  });
}

/**
 * Nomlar o'qishda: katalog nomi → qatordagi `product_name` → «Tovar #id».
 * `productNames` — `catalog.product.find_by_ids` dan (id → nom).
 */
export function withExtraCostItemNames(
  items: ExtraCostApprovalItem[] | null | undefined,
  productNames: Map<string, string>,
): ExtraCostApprovalItem[] {
  return (items ?? []).map((item) => {
    const catalogName = item.product_id
      ? productNames.get(String(item.product_id))
      : undefined;
    const name =
      (catalogName && String(catalogName).trim()) ||
      (item.product_name && String(item.product_name).trim()) ||
      `Tovar #${item.product_id ?? item.order_item_id ?? '?'}`;
    return { ...item, product_name: name };
  });
}

/**
 * «Telefon g'ilofi ×1, Zaryadka ×2» — xabar va kassa izohlari uchun.
 * Qisman sotuvda faqat sotilgan (miqdori > 0) qatorlar; hammasi 0 bo'lsa —
 * hammasi. `max` dan ko'pi «+N».
 */
export function formatExtraCostItems(
  items: ExtraCostApprovalItem[] | null | undefined,
  max = 5,
): string {
  const all = items ?? [];
  const positive = all.filter((item) => Number(item.quantity) > 0);
  const list = positive.length ? positive : all;
  const parts = list
    .slice(0, max)
    .map(
      (item) =>
        `${item.product_name ?? `Tovar #${item.product_id ?? item.order_item_id ?? '?'}`} ×${Number(item.quantity) || 0}`,
    );
  if (list.length > max) {
    parts.push(`+${list.length - max}`);
  }
  return parts.join(', ');
}

/**
 * Eski (replay / immediate) qatorda `items` yo'q — qisman sotuvda
 * `operation_payload.order_item_info` dan, aks holda buyurtmaning hozirgi
 * qatorlaridan tiklanadi.
 */
export function legacyExtraCostItems(params: {
  action: ExtraCostApprovalAction;
  payload: Record<string, unknown> | null | undefined;
  orderItems:
    | Array<{
        id?: unknown;
        product_id?: unknown;
        product_name?: string | null;
        quantity?: unknown;
      }>
    | null
    | undefined;
}): ExtraCostApprovalItem[] {
  const info = params.payload?.order_item_info;
  if (params.action === 'partly_sell' && Array.isArray(info)) {
    const orderItems = params.orderItems ?? [];
    return (info as Array<Record<string, unknown> | null>).map((raw) => {
      const orderItemId = toId(raw?.order_item_id);
      const productId = toId(raw?.product_id);
      const match =
        orderItems.find(
          (item) => orderItemId && toId(item?.id) === orderItemId,
        ) ??
        orderItems.find(
          (item) => productId && toId(item?.product_id) === productId,
        );
      const quantity = Math.max(Number(raw?.quantity ?? 0) || 0, 0);
      return {
        order_item_id: orderItemId ?? toId(match?.id),
        product_id: productId ?? toId(match?.product_id),
        product_name: match?.product_name ?? null,
        quantity,
        sold_quantity: quantity,
      };
    });
  }
  return extraCostItemsFromOrderItems(params.orderItems);
}

/**
 * (SPEC v2 §3.5) Tasdiqda market buyurtmasi hisobi. `paidPortion =
 * min(paid_amount, to_be_paid)`, `net = to_be_paid − E`:
 *  • `paidPortion ≥ net` va holat SOLD / PARTLY_PAID / PAID — PAID,
 *    `paid_amount = to_be_paid` (finance F:944/1062 konventsiyasi: PAID da
 *    to'langan qism = paid − extra_cost); ortiqcha = paidPortion − net —
 *    finance uni keyingi buyurtmalarga qo'llaydi (pul ko'chirmasdan);
 *  • aks holda holat o'zgarmaydi — FIFO keyin yopadi (qoldiq = net − paid).
 * CLOSED va bekor oilasi — faqat `extra_cost`.
 */
export function computeDeferredExtraCostOrderState(params: {
  status: string;
  toBePaid: number;
  paidAmount: number;
  extraCost: number;
}): { status: string; paidAmount: number; overage: number } {
  const toBePaid = Math.max(Number(params.toBePaid) || 0, 0);
  const paid = Math.max(Number(params.paidAmount) || 0, 0);
  const extraCost = Math.max(Number(params.extraCost) || 0, 0);
  const marketOrderStatuses: string[] = [
    Order_status.SOLD,
    Order_status.PARTLY_PAID,
    Order_status.PAID,
  ];
  if (!marketOrderStatuses.includes(String(params.status))) {
    return { status: params.status, paidAmount: paid, overage: 0 };
  }
  const paidPortion = Math.min(paid, toBePaid);
  const net = toBePaid - extraCost;
  if (paidPortion >= net) {
    // E > to_be_paid (manfiy net) ham shu formula: finance FIFO manfiy
    // qoldiqli buyurtmani PAID qilib, |qoldiq| ni hovuzga qo'shadi (F:937) —
    // bugungi «tasdiqsiz E» bilan bir xil natija.
    return {
      status: Order_status.PAID,
      paidAmount: toBePaid,
      overage: Math.max(paidPortion - net, 0),
    };
  }
  return { status: params.status, paidAmount: paid, overage: 0 };
}
