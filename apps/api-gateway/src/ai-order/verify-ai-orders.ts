/**
 * ai-confirm SERVER TOMONDA QAYTA TEKSHIRUVI (wgqxS0Cp, 32fNx0Ci; PLAN C10).
 *
 * ⚠️ Mijozga (frontend preview'iga) ISHONILMAYDI — AI xatosi yoki qo'lda
 * tahrirlangan so'rov bazaga faqat shu tekshiruvdan o'tib kiradi:
 *  - tuman DB'da bo'lishi va o'chirilmagan bo'lishi SHART;
 *  - `customer.district_id` buyurtmaning `district_id` siga teng bo'lishi SHART;
 *  - `region_id` HAR DOIM DB'dagi tuman yozuvidan olinadi — tanadagi
 *    `region_id` umuman o'qilmaydi;
 *  - har `product_id` katalogda bo'lishi va AYNAN shu marketniki bo'lishi
 *    SHART (`String(user_id) === marketId`) — boshqa marketning mahsuloti
 *    bilan buyurtma yaratib bo'lmaydi.
 *
 * Sof funksiya: RPC chaqirmaydi. Tuman va mahsulot qatorlarini chaqiruvchi
 * partiyaga BITTADAN `find_by_ids` bilan o'qib beradi. ID'lar satr sifatida
 * solishtiriladi (bigint → string).
 */

export type AiVerifyFailureCode =
  | 'district_not_found'
  | 'district_mismatch'
  | 'product_not_found'
  | 'product_foreign';

export type AiVerifyResult =
  | { ok: true; district_id: string; region_id: string }
  | { ok: false; code: AiVerifyFailureCode; reason: string };

/** Odam o'qiydigan o'zbekcha sabab — frontend uni o'zgartirmasdan ko'rsatadi. */
export const AI_VERIFY_REASON_TEXT: Readonly<
  Record<AiVerifyFailureCode, string>
> = Object.freeze({
  district_not_found:
    'Tuman topilmadi yoki o‘chirilgan — tumanni qayta tanlang',
  district_mismatch:
    'Mijoz tumani buyurtma tumani bilan bir xil emas — tumanni qayta tanlang',
  product_not_found: 'Mahsulot katalogda topilmadi — mahsulotni qayta tanlang',
  product_foreign:
    'Mahsulot bu marketga tegishli emas — mahsulotni qayta tanlang',
});

/** Tekshiruvga kerakli minimal buyurtma shakli (`AiConfirmOrderDto` unga mos). */
export interface AiVerifyOrderInput {
  district_id?: unknown;
  customer?: { district_id?: unknown } | null;
  items?: ReadonlyArray<{ product_id?: unknown } | null | undefined> | null;
}

export interface AiVerifyContext {
  /** Server tomonda aniqlangan market (`resolveAiMarket`). */
  marketId: string;
  /** `logistics.district.find_by_ids` qatorlari. */
  districts: ReadonlyArray<Record<string, unknown>>;
  /** `catalog.product.find_by_ids` qatorlari. */
  products: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Massiv bo'lsa o'zi, aks holda bo'sh massiv. (`Array.isArray` readonly
 * massivni `any[]` ga toraytirib yuboradi — tip shu yerda qaytariladi.)
 */
function listOf<T>(
  value: ReadonlyArray<T> | null | undefined,
): ReadonlyArray<T> {
  return Array.isArray(value) ? (value as ReadonlyArray<T>) : [];
}

/** bigint/number/string ID → kesilgan satr; boshqa har narsa → ''. */
function idOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}

function isDeletedRow(row: Record<string, unknown>): boolean {
  return row.isDeleted === true || row.is_deleted === true;
}

function indexById(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object') continue;
    const id = idOf(row.id);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

function fail(code: AiVerifyFailureCode, reason?: string): AiVerifyResult {
  return { ok: false, code, reason: reason ?? AI_VERIFY_REASON_TEXT[code] };
}

/**
 * Mahsulot xatosida qaysi qator ekanini ko'rsatamiz (bir buyurtmada bir necha
 * mahsulot bo'lishi mumkin). ID — PII emas.
 */
function productReason(
  code: 'product_not_found' | 'product_foreign',
  productId: string,
): string {
  return code === 'product_not_found'
    ? `Mahsulot #${productId} katalogda topilmadi — mahsulotni qayta tanlang`
    : `Mahsulot #${productId} bu marketga tegishli emas — mahsulotni qayta tanlang`;
}

/**
 * Har buyurtma uchun (kirish tartibida, indeks bo'yicha mos) natija:
 * `{ok:true, district_id, region_id}` yoki `{ok:false, code, reason}`.
 * Birinchi topilgan xato qaytadi: tuman → moslik → mahsulotlar.
 */
export function verifyAiOrders(
  orders: ReadonlyArray<AiVerifyOrderInput>,
  ctx: AiVerifyContext,
): AiVerifyResult[] {
  const districtsById = indexById(ctx.districts);
  const productsById = indexById(ctx.products);
  const marketId = idOf(ctx.marketId);

  return listOf(orders).map((order): AiVerifyResult => {
    const districtId = idOf(order?.district_id);
    const district = districtId ? districtsById.get(districtId) : undefined;
    if (!district || isDeletedRow(district)) {
      return fail('district_not_found');
    }

    if (idOf(order?.customer?.district_id) !== districtId) {
      return fail('district_mismatch');
    }

    // ⚠️ region_id — FAQAT DB'dagi tuman yozuvidan (mijoz yuborgani emas).
    const regionRef = district.region as { id?: unknown } | null | undefined;
    const regionId = idOf(district.region_id) || idOf(regionRef?.id);
    if (!regionId) {
      // Viloyatsiz tuman yozuvi — buzuq qator; region_id'siz buyurtma
      // yaratilmaydi.
      return fail('district_not_found');
    }

    const items = listOf(order?.items);
    for (const item of items) {
      const productId = idOf(item?.product_id);
      // product_id siz qator — katalogda yo'q (erkin matn) mahsulot; uning
      // ruxsati (`allow_unlisted_product`) DTO'da tekshiriladi.
      if (!productId) continue;
      const product = productsById.get(productId);
      if (!product || isDeletedRow(product)) {
        return fail(
          'product_not_found',
          productReason('product_not_found', productId),
        );
      }
      if (!marketId || idOf(product.user_id) !== marketId) {
        return fail(
          'product_foreign',
          productReason('product_foreign', productId),
        );
      }
    }

    return { ok: true, district_id: districtId, region_id: regionId };
  });
}
