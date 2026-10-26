/**
 * hY7uacJu — vaqtinchalik ombor moduli (catalog-service `warehouse/`):
 * umumiy konstantalar va sof hisob funksiyalari. Gateway DTO'lari,
 * catalog-service va (keyingi PR'da) order-service SHU fayldan oladi —
 * holat/tur nomlari va sabab kodlari ikki joyda yozilmaydi.
 *
 * Model (ega qarorlari 2026-10-23, 2026-10-25):
 *   - ombor filialga bog'langan (`branch_id` yagona), FAOL yoki
 *     TO'XTATILGAN; to'xtatilganda qoldiq saqlanadi, yangi buyurtma tushmaydi;
 *   - turi (`kind`, saqlanmaydi — filialdan hisoblanadi): viloyat ombori
 *     (REGIONAL/HYBRID filial) yoki Markaziy ombor (HQ filiali, Pa1KaXmj).
 *     Buyurtma manbasi (VkKDSNNn, 2-bosqich): avval viloyat ombori, u
 *     bo'lmasa Markaziy ombor (faqat `WAREHOUSE_HQ_TIER_ENABLED` yoqilganda),
 *     ikkalasida ham yetmasa — HQ (market olib keladi). Kalit o'chiq bo'lsa
 *     Markaziy ombor nomzod EMAS (1-bosqichdagidek);
 *   - qoldiq faqat dona: `on_hand` (jismonan bor), `reserved` (faol
 *     buyurtmalarga band), `available = on_hand − reserved`;
 *   - har o'zgarish `stock_movements` ga yoziladi (faqat qo'shiladi).
 */

export const WAREHOUSE_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

/**
 * Pa1KaXmj: ombor turi (javoblardagi `kind`). `REGIONAL` — viloyat filiali
 * (REGIONAL/HYBRID) ombori; `HQ` — «Markaziy ombor» (HQ filialida, tizimda
 * ko'pi bilan bitta). DB'da ustun yo'q — `branch_id` dan hisoblanadi.
 */
export const WAREHOUSE_KINDS = ['REGIONAL', 'HQ'] as const;
export type WarehouseKind = (typeof WAREHOUSE_KINDS)[number];

/**
 * Harakat turlari. `qty` ishorasi (DB CHECK bilan qulflangan):
 *   - IN, RETURN, MOVE_IN — `on_hand` +n;
 *   - OUT, MOVE_OUT — `on_hand` −n (OUT da `reserved` ham −n);
 *   - ADJUST — `on_hand` ±n (inventarizatsiya farqi);
 *   - RESERVE — `reserved` +n; RELEASE — `reserved` −n (`on_hand` o'zgarmaydi).
 */
export const STOCK_MOVEMENT_TYPES = [
  'IN',
  'ADJUST',
  'RESERVE',
  'RELEASE',
  'OUT',
  'RETURN',
  'MOVE_OUT',
  'MOVE_IN',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** Harakat manbasi (`stock_movements.ref_type`). */
export const STOCK_MOVEMENT_REF_TYPES = [
  'stock_in',
  'inventory',
  'order',
  'move',
] as const;
export type StockMovementRefType = (typeof STOCK_MOVEMENT_REF_TYPES)[number];

/**
 * Buyurtma bandi (`stock_reservations.status`):
 *   RESERVED → (bekor) RELEASED
 *   RESERVED → (kuryerga berildi) OUT → (filialga qaytdi) RETURNED
 * OUT qatorida `returned_qty < qty` — qisman qaytgan (qisman sotuv).
 */
export const STOCK_RESERVATION_STATUSES = [
  'RESERVED',
  'RELEASED',
  'OUT',
  'RETURNED',
] as const;
export type StockReservationStatus =
  (typeof STOCK_RESERVATION_STATUSES)[number];

/** Pozitsiya holati (ekranda: Yetarli / Kam qoldi / Tugagan). */
export const WAREHOUSE_STOCK_LEVELS = ['ok', 'low', 'out'] as const;
export type WarehouseStockLevel = (typeof WAREHOUSE_STOCK_LEVELS)[number];

/** Buyurtma manbasi — order-service `orders.fulfillment_source` bilan AYNI. */
export const FULFILLMENT_SOURCES = ['HQ', 'WAREHOUSE'] as const;
export type FulfillmentSource = (typeof FULFILLMENT_SOURCES)[number];

/**
 * 6kHnNH9j: yaratishdagi manba tanlovi (`POST /orders` / ai-confirm
 * `fulfillment`). `auto` — `resolve_source` (hamma mahsulot yetarli bo'lsa
 * ombor, aks holda HQ); `hq` — har doim HQ (hozirgi oqim).
 */
export const ORDER_FULFILLMENT_MODES = ['auto', 'hq'] as const;
export type OrderFulfillmentMode = (typeof ORDER_FULFILLMENT_MODES)[number];

/**
 * `catalog.warehouse.resolve_source` sababi. `OK` — ombor tanlandi; qolgani —
 * butun buyurtma HQ'dan (qaror 4: bo'linmaydi).
 */
export const WAREHOUSE_SOURCE_REASONS = [
  'OK',
  'NO_ITEMS',
  'NO_REGION',
  'NO_WAREHOUSE',
  'WAREHOUSE_PAUSED',
  'INSUFFICIENT_STOCK',
  'MARKET_NOT_ALLOWED',
  'PRODUCT_INVALID',
] as const;
export type WarehouseSourceReason = (typeof WAREHOUSE_SOURCE_REASONS)[number];

/**
 * VkKDSNNn: Markaziy ombor pog'onasi sababi (`resolve_source` javobidagi
 * `hq_reason`). Viloyat ombori tanlanmaganda, kalit yoqilgan bo'lsa Markaziy
 * ombor ko'rib chiqiladi; u ham to'g'ri kelmasa javob `source: 'HQ'` (market
 * olib keladi), asosiy `reason` — viloyat sababi, `hq_reason` — Markaziy
 * omborniki. `WAREHOUSE_SOURCE_REASONS` ga ATAYLAB qo'shilmagan — `reason`
 * enum'i (va eski frontend) o'zgarmaydi.
 */
export const HQ_WAREHOUSE_REASONS = [
  'NO_HQ_WAREHOUSE',
  'HQ_WAREHOUSE_PAUSED',
  'HQ_INSUFFICIENT_STOCK',
] as const;
export type HqWarehouseReason = (typeof HQ_WAREHOUSE_REASONS)[number];

/**
 * VkKDSNNn: Markaziy ombor pog'onasining kaliti (catalog-service env, sukut
 * `false`). O'chiq bo'lsa `resolve_source`/`availability` javobi 1-bosqichdagi
 * bilan AYNAN bir xil. ⚠️ Yoqishdan oldin order-service'da Markaziy ombor
 * buyurtmasi oqimi (HQ'da qabul, pochta, chiqim, qaytish) deploy bo'lgan
 * bo'lishi shart.
 */
export const WAREHOUSE_HQ_TIER_FLAG = 'WAREHOUSE_HQ_TIER_ENABLED';

/** RpcException `code` lari (order-service shu kodlar bo'yicha qaror qiladi). */
export const WAREHOUSE_ERROR_CODES = {
  NOT_FOUND: 'WAREHOUSE_NOT_FOUND',
  PAUSED: 'WAREHOUSE_PAUSED',
  STOCK_INSUFFICIENT: 'WAREHOUSE_STOCK_INSUFFICIENT',
  ORDER_ALREADY_RESERVED: 'WAREHOUSE_ORDER_ALREADY_RESERVED',
  ORDER_ALREADY_OUT: 'WAREHOUSE_ORDER_ALREADY_OUT',
  ORDER_RELEASED: 'WAREHOUSE_ORDER_RELEASED',
  IDEMPOTENCY_CONFLICT: 'WAREHOUSE_IDEMPOTENCY_CONFLICT',
  /**
   * XtcEyQjb: market operatoriga «Ombordagi qoldiq» yopiq (market kalitni
   * yoqmagan) — gateway 403.
   */
  STOCK_FORBIDDEN: 'WAREHOUSE_STOCK_FORBIDDEN',
  /**
   * VkKDSNNn: Markaziy ombor buyurtmasi bekor/qaytishda Markaziy omborga
   * qaytadi — marketga topshirib bo'lmaydi (order-service, 409).
   */
  ORDER_RETURNS_TO_STOCK: 'WAREHOUSE_ORDER_RETURNS_TO_STOCK',
} as const;

/** RMQ naqshlari — catalog-service `WarehouseController` bilan AYNI. */
export const WAREHOUSE_RPC = {
  CREATE: 'catalog.warehouse.create',
  UPDATE: 'catalog.warehouse.update',
  PAUSE: 'catalog.warehouse.pause',
  RESUME: 'catalog.warehouse.resume',
  FIND_ALL: 'catalog.warehouse.find_all',
  FIND_BY_ID: 'catalog.warehouse.find_by_id',
  STOCK: 'catalog.warehouse.stock',
  MOVEMENTS: 'catalog.warehouse.movements',
  LOOKUP: 'catalog.warehouse.lookup',
  STOCK_IN: 'catalog.warehouse.stock_in',
  INVENTORY: 'catalog.warehouse.inventory',
  SET_THRESHOLD: 'catalog.warehouse.set_threshold',
  MARKET_STOCK: 'catalog.warehouse.market_stock',
  AVAILABILITY: 'catalog.warehouse.availability',
  RESOLVE_SOURCE: 'catalog.warehouse.resolve_source',
  RESERVE: 'catalog.warehouse.reserve',
  RELEASE: 'catalog.warehouse.release',
  OUT: 'catalog.warehouse.out',
  RETURN: 'catalog.warehouse.return',
  ORDER_STATE: 'catalog.warehouse.order_state',
  FIND_BY_IDS: 'catalog.warehouse.find_by_ids',
} as const;

/** Qaror 12: hisob vazni = max(og'irlik, U×K×B / 5000). */
export const WAREHOUSE_VOLUMETRIC_DIVISOR = 5000;
/** Yangi ombor uchun «kam qoldiq» chegarasi sukuti (dona). */
export const WAREHOUSE_LOW_STOCK_DEFAULT = 5;
export const WAREHOUSE_LOW_STOCK_MAX = 100_000;
/** Bitta kirim/inventarizatsiya/buyurtma qatorlari soni chegarasi. */
export const WAREHOUSE_MAX_LINES = 200;
/** Bitta qatordagi dona chegarasi. */
export const WAREHOUSE_MAX_QTY = 100_000;
export const WAREHOUSE_NAME_MAX = 160;
export const WAREHOUSE_ADDRESS_MAX = 255;
export const WAREHOUSE_NOTE_MAX = 1000;
export const WAREHOUSE_REASON_MIN = 3;
/** `Idempotency-Key` sarlavhasi shakli. */
export const WAREHOUSE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface WarehouseMeasureInput {
  weight_kg?: number | string | null;
  length_cm?: number | string | null;
  width_cm?: number | string | null;
  height_cm?: number | string | null;
  volumetric_enabled?: boolean | null;
}

export interface WarehouseChargeableWeight {
  /** max(haqiqiy, hajmli) — kg, 3 kasr; o'lchov yo'q bo'lsa `null`. */
  chargeable_weight_kg: number | null;
  /** U×K×B/5000 — kg, 3 kasr; o'lcham yo'q yoki hajm o'chiq bo'lsa `null`. */
  volumetric_weight_kg: number | null;
  /** Qaysi biri katta: «hajm bo'yicha» belgisi uchun. */
  chargeable_basis: 'actual' | 'volumetric' | null;
  /**
   * Og'irlik yo'q — narx dvigateli uni «o'lchovsiz» deb sanaydi
   * (`unmeasuredItems`), ekranda «O'lchov yo'q — yetkazish narxi
   * hisoblanmaydi».
   */
  measure_missing: boolean;
}

const toPositive = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Ekrandagi «Hisob vazni» (qaror 12). Narx dvigateli (`computeDeliveryQuote`)
 * 0.1 kg qadam bilan yuqoriga yaxlitlaydi — bu yerda faqat ko'rsatish
 * qiymati (3 kasr), narx hisoblanmaydi.
 *
 * AQ9lkgVB: hajm chegarasi (`volumetric_from_kg`) bu yerda ATAYLAB
 * qo'llanmaydi — u butun jo'natma yig'indisiga (Σ U×K×B × dona) tegishli,
 * bitta dona ko'rinishi uni to'g'ri aks ettira olmaydi (2 dona 1,6 kg
 * hajm = 3,2 kg — chegara 3 da hajm qo'llanadi). Chegara faqat narx
 * dvigatelida; bu ko'rinish — mahsulotning chegarasiz hisob vazni.
 */
export function warehouseChargeableWeight(
  product: WarehouseMeasureInput,
): WarehouseChargeableWeight {
  const actual = toPositive(product.weight_kg);
  const length = toPositive(product.length_cm);
  const width = toPositive(product.width_cm);
  const height = toPositive(product.height_cm);
  const volumetric =
    length !== null &&
    width !== null &&
    height !== null &&
    product.volumetric_enabled !== false
      ? round3((length * width * height) / WAREHOUSE_VOLUMETRIC_DIVISOR)
      : null;
  if (actual === null && volumetric === null) {
    return {
      chargeable_weight_kg: null,
      volumetric_weight_kg: null,
      chargeable_basis: null,
      measure_missing: true,
    };
  }
  const actualValue = actual === null ? null : round3(actual);
  const useVolumetric =
    volumetric !== null && (actualValue === null || volumetric > actualValue);
  return {
    chargeable_weight_kg: useVolumetric ? volumetric : actualValue,
    volumetric_weight_kg: volumetric,
    chargeable_basis: useVolumetric ? 'volumetric' : 'actual',
    measure_missing: actual === null,
  };
}

/**
 * Pozitsiya holati — MAVJUD (on_hand − reserved) bo'yicha: 0 va kam — «Tugagan»,
 * chegaragacha (shu jumladan) — «Kam qoldi», undan ko'p — «Yetarli».
 */
export function warehouseStockLevel(
  available: number,
  threshold: number,
): WarehouseStockLevel {
  if (available <= 0) return 'out';
  if (available <= threshold) return 'low';
  return 'ok';
}

export type WarehouseCodeFormat =
  | 'ELC'
  | 'EAN-13'
  | 'EAN-8'
  | 'GTIN-14'
  | 'TEXT';

/**
 * Ekrandagi kod: zavod shtrix kodi bo'lsa o'sha (qaror 11), aks holda Elchi
 * QR kodi `ELC-P-…`. `format` — yorliq uchun («Zavod shtrix kodi (EAN-13)»).
 */
export function warehouseDisplayCode(product: {
  barcode?: string | null;
  sku_code?: string | null;
}): {
  value: string | null;
  kind: 'barcode' | 'sku';
  format: WarehouseCodeFormat;
} {
  const barcode =
    typeof product.barcode === 'string' ? product.barcode.trim() : '';
  if (barcode) {
    const format: WarehouseCodeFormat = /^\d{13}$/.test(barcode)
      ? 'EAN-13'
      : /^\d{8}$/.test(barcode)
        ? 'EAN-8'
        : /^\d{14}$/.test(barcode)
          ? 'GTIN-14'
          : 'TEXT';
    return { value: barcode, kind: 'barcode', format };
  }
  return { value: product.sku_code ?? null, kind: 'sku', format: 'ELC' };
}
