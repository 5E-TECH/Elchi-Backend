import type { FindOptionsSelect } from 'typeorm';
import type { Order } from '../entities/order.entity';

/**
 * D148eHMA — SKANER uchun YENGIL buyurtma javobi (`?view=light`).
 *
 * MUAMMO. Skaner ekranlari (scan detali, menejer "Biriktirish", buyurtmalar /
 * pochta / kuryer ro'yxatidagi skan) `order.find_by_qr_enriched` ning TO'LIQ
 * daraxtini olardi: barcha pul snapshotlari (tarif, ulush, kassa summasi),
 * `branch` yozuvi to'liq, market (token/tariflari bilan) va mijoz to'liq,
 * mahsulot katalog yozuvi to'liq — ~4.5 KB. Ombor operatori ketma-ket
 * skanerlaganda har skan shu yukni DB -> RMQ -> HTTP orqali tashirdi.
 *
 * YECHIM. Faqat skaner ekranlari ISHLATADIGAN maydonlar qaytadi
 * (Elchi-Frontend grep: `pages/scan/detail.tsx`, `pages/dispatch`,
 * `pages/orders`, `pages/mails/detail`, `pages/orders/list/courier`):
 *  - moslashtirish identifikatorlari: `id`, `qr_code_token`, `parent_order_id`,
 *    `customer_id`, `market_id`, `district_id`, `region_id`;
 *  - ekran: holat, yetkazish turi, summa, manzil, izoh, sana, operator;
 *  - nomlar: mijoz (ism, telefon, manzil), market nomi, tuman/viloyat nomi,
 *    mahsulot nomi + soni.
 *
 * ⚠️ `market_id` ATAYLAB qoldirilgan: gateway'dagi market ko'rinish
 * tekshiruvi (`assertQrOrderVisible`) aynan shu maydonga tayanadi — u yo'q
 * bo'lsa market BEGONA posilkani ko'rmaydi (403), lekin o'zinikini ham.
 */

/** DB'dan faqat shu ustunlar o'qiladi; `branch` JOIN qilinmaydi. */
export const ORDER_SCAN_LIGHT_SELECT: FindOptionsSelect<Order> = {
  id: true,
  qr_code_token: true,
  parent_order_id: true,
  status: true,
  where_deliver: true,
  total_price: true,
  address: true,
  comment: true,
  operator: true,
  createdAt: true,
  market_id: true,
  customer_id: true,
  district_id: true,
  region_id: true,
  items: {
    id: true,
    product_id: true,
    product_name: true,
    quantity: true,
  },
};

const ORDER_FIELDS = [
  'id',
  'order_number',
  'qr_code_token',
  'parent_order_id',
  'status',
  'where_deliver',
  'total_price',
  'address',
  'comment',
  'operator',
  'createdAt',
  'market_id',
  'customer_id',
  'district_id',
  'region_id',
] as const;

const ID_NAME = ['id', 'name'] as const;
const CUSTOMER_FIELDS = ['id', 'name', 'phone_number', 'address'] as const;
const ITEM_FIELDS = ['id', 'product_id', 'product_name', 'quantity'] as const;

type Row = Record<string, unknown>;

/**
 * Oq ro'yxat bo'yicha maydonlarni ko'chiradi. Obyekt bo'lmasa yoki birorta
 * maydon topilmasa — `null` (frontend `customer?.name` kabi o'qiydi).
 */
const pick = (value: unknown, keys: readonly string[]): Row | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Row;
  const out: Row = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return Object.keys(out).length ? out : null;
};

/**
 * `enrichOrders` natijasini (yoki xom buyurtmani) skaner uchun yengil
 * ko'rinishga keltiradi. Kirish obyekti o'zgartirilmaydi.
 */
export function toOrderScanLightView(order: unknown): Row {
  const row = (order && typeof order === 'object' ? order : {}) as Row;
  const out: Row = pick(row, ORDER_FIELDS) ?? {};
  out.market = pick(row.market, ID_NAME);
  out.customer = pick(row.customer, CUSTOMER_FIELDS);
  out.district = pick(row.district, ID_NAME);
  out.region = pick(row.region, ID_NAME);
  out.items = (Array.isArray(row.items) ? row.items : []).map((item) => ({
    ...pick(item, ITEM_FIELDS),
    product: pick((item as Row | null)?.product, ID_NAME),
  }));
  return out;
}
