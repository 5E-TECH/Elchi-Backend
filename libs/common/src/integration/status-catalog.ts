import { Order_status } from '../../enums';

/**
 * KANONIK STATUS KATALOGI (JnHK6bgV) — integratsiya status xaritalari uchun
 * YAGONA manba.
 *
 * ⚠️ RO'YXAT QO'LDA YOZILMAYDI: posilka kodlari `Order_status` enumidan
 * hosil qilinadi. Izohlar `Record<Order_status, …>` — enumga yangi qiymat
 * qo'shilsa va bu yerda izoh yozilmasa KOMPILYATSIYA yiqiladi, ya'ni UI va
 * backend jimgina ajralib ketmaydi.
 *
 * ⚠️ Ba'zi kodlarda probel va qavs bor (`on the road`, `cancelled (sent)`) —
 * URL, i18n kaliti va test snapshot'lari uchun `key` (slug) beriladi; xarita
 * KALITI esa o'zgarmas `code` bo'lib qoladi (saqlangan xaritalar buzilmaydi).
 */

export interface StatusCatalogEntry {
  /** Xaritada saqlanadigan haqiqiy qiymat. */
  code: string;
  /** i18n / URL uchun xavfsiz slug (`cancelled (sent)` → `cancelled_sent`). */
  key: string;
  /** Operator tilida o'zbekcha izoh (frontend tarjima topmasa shuni ko'rsatadi). */
  meaning_uz: string;
}

export const toStatusKey = (code: string): string =>
  code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const SHIPMENT_STATUS_MEANING_UZ: Readonly<Record<Order_status, string>> =
  Object.freeze({
    [Order_status.CREATED]: 'Yaratildi, hali tasdiqlanmagan',
    [Order_status.NEW]: 'Yangi — qabul qilinishi kutilmoqda',
    [Order_status.RECEIVED]: 'Omborga (filialga) qabul qilindi',
    [Order_status.ON_THE_ROAD]: "Yo'lda — filiallar orasida",
    [Order_status.WAITING]: 'Kuryerda, yetkazish kutilmoqda',
    [Order_status.WAITING_CUSTOMER]: 'Mijozni kutmoqda (qayta urinish)',
    [Order_status.SOLD]: 'Yetkazildi, pul olindi',
    [Order_status.CANCELLED]: 'Mijoz rad etdi / bekor qilindi',
    [Order_status.RETURNED_TO_MARKET]: 'Marketga qaytarildi',
    [Order_status.PAID]: "Marketga to'liq to'landi",
    [Order_status.PARTLY_PAID]: "Marketga qisman to'landi",
    [Order_status.CANCELLED_SENT]: "Bekor qilingan, qaytarishga jo'natildi",
    [Order_status.CLOSED]: 'Yopildi — hisob-kitob tugagan',
  });

/** Posilka (buyurtma) holatlari — `Order_status` tartibida. */
export const CANONICAL_SHIPMENT_STATUSES: readonly StatusCatalogEntry[] =
  Object.freeze(
    (Object.values(Order_status) as Order_status[]).map((code) => ({
      code,
      key: toStatusKey(code),
      meaning_uz: SHIPMENT_STATUS_MEANING_UZ[code],
    })),
  );

/**
 * Onlayn to'lov holatlari (`payment_transactions.status`). To'lov xaritasi
 * (`payment_config.status_map`) posilka katalogini EMAS, shuni oladi.
 */
export const PAYMENT_TXN_STATUSES = [
  'succeeded',
  'pending',
  'failed',
  'refunded',
] as const;
export type PaymentTxnStatus = (typeof PAYMENT_TXN_STATUSES)[number];

const PAYMENT_STATUS_MEANING_UZ: Readonly<Record<PaymentTxnStatus, string>> =
  Object.freeze({
    succeeded: "To'lov o'tdi",
    pending: "To'lov jarayonda",
    failed: "To'lov o'tmadi",
    refunded: 'Pul qaytarildi',
  });

export const CANONICAL_PAYMENT_STATUSES: readonly StatusCatalogEntry[] =
  Object.freeze(
    PAYMENT_TXN_STATUSES.map((code) => ({
      code,
      key: toStatusKey(code),
      meaning_uz: PAYMENT_STATUS_MEANING_UZ[code],
    })),
  );

/**
 * Kiruvchi xaritada (`inbound_status_mapping`) yangi kod uchun sukut
 * `action` — buyurtmani yakuniy holatga o'tkazadigan statuslar. Mavjud
 * yozuvning `action` i saqlanadi; bu faqat yangi qo'shilgan kodga.
 */
export const INBOUND_DEFAULT_ACTION: Readonly<
  Partial<Record<Order_status, 'sell' | 'cancel' | 'return'>>
> = Object.freeze({
  [Order_status.SOLD]: 'sell',
  [Order_status.CANCELLED]: 'cancel',
  [Order_status.RETURNED_TO_MARKET]: 'return',
});

export const STATUS_CATALOG = Object.freeze({
  shipment: CANONICAL_SHIPMENT_STATUSES,
  payment: CANONICAL_PAYMENT_STATUSES,
  inbound_default_action: INBOUND_DEFAULT_ACTION,
});
