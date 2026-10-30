/**
 * KmWO9gTA / 6tGZzupr — MARKET TARIFINING YAGONA MANBASI (sof funksiyalar).
 *
 * Bu yerdagi qaror ikki joyda ishlatiladi va AJRALMASLIGI kerak:
 *   - order-service sotuvi (`domain/order-money.ts`, `pricing/sale-pricing.ts`
 *     shu faylni qayta eksport qiladi) — Elchi REAL oladigan summa;
 *   - api-gateway `GET /partner/tariff` — xaridorga savatda ko'rsatiladigan
 *     summa. Ilgari u yerda mustaqil `center ? tariff_center : tariff_home`
 *     nusxasi turardi va sotuv dvigateli yoqilsa jimgina ajralib qolardi.
 *
 * Hisobning o'zi (vazn/hajm) bu yerda EMAS: `computeDeliveryQuote`
 * (`delivery-pricing.ts`, logistics-service orqali).
 */

/**
 * KmWO9gTA — sotuvda yetkazish narxi dvigateli (logistics
 * `logistics.delivery.sale_quote`) natijasining MARKET oyog'iga kerakli
 * qismi. Dvigatel FAQAT `SALE_PRICING_ENGINE` yoqilgan va marketning
 * `weight_volume_pricing` bayrog'i TRUE bo'lganda chaqiriladi.
 */
export interface SaleEngineQuote {
  /**
   * Vazn/hajm qo'shimchasi, so'm: (hisob vazni − 1-kg) × tarif jadvalidagi
   * kg narxi (`computeDeliveryQuote().extra`). Ega qarori 2026-10-19:
   * «standart narx + vazn yoki hajm uchun qo'shimcha».
   */
  surcharge: number;
  /**
   * Tarif jadvali bazasi (yo'nalish tarifining `base_price`). Faqat market
   * profilida standart narx YO'Q (NULL) bo'lganda baza sifatida olinadi.
   */
  tableBase: number;
  /** Sozlamadagi minimal yetkazish narxi (`min_delivery_price`), NULL — yo'q. */
  minDeliveryPrice?: number | null;
}

/** Market tarifi qayerdan olindi — jurnal va testlar uchun. */
export type MarketTariffSource = 'snapshot' | 'profile' | 'engine';

export interface MarketTariffResolution {
  /** Sotuvda ishlatiladigan (va snapshot qilinadigan) tarif. */
  tariff: number;
  source: MarketTariffSource;
  /** Market profilidagi standart narx (`where_deliver` bo'yicha), NULL — yo'q. */
  standard: number | null;
  /** Dvigatel bazasi: standart narx, u bo'lmasa — tarif jadvali bazasi. */
  base: number;
  /** Vazn/hajm qo'shimchasi (faqat `engine`), aks holda 0. */
  surcharge: number;
  /** base + surcharge — floor'dan OLDINGI hisob (faqat `engine`). */
  computed: number;
  /** Minimal narx: max(kuryer + filial ulushi, `min_delivery_price`). */
  floor: number;
  /** Hisoblangan narx floor'dan past bo'lib, floor'ga ko'tarildimi. */
  floorApplied: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The tariff ONE order must be settled with — with the full breakdown.
 *
 *   1. snapshot (`order.market_tariff` / `courier_tariff`) — HAR DOIM birinchi:
 *      eski / allaqachon sotilgan buyurtmaning narxi hech qachon orqaga
 *      o'zgarmaydi (KmWO9gTA TC2);
 *   2. `engine` berilmasa — avvalgi xulq BAYTMA-BAYT: profil tarifi
 *      (`isCenter ? center : home`), ikkisi ham yo'q bo'lsa 0;
 *   3. `engine` berilsa (KmWO9gTA, ega qarori 2026-10-19) — standart narx
 *      (profil; yo'q bo'lsa tarif jadvali bazasi) + vazn/hajm qo'shimchasi,
 *      so'ng MINIMAL NARX (floor) — kuryer + filial ulushi va
 *      `min_delivery_price` dan past bo'lsa shu qiymatga ko'tariladi
 *      (DARVOZA 1: kichik/yengil posilkada sotuv to'xtamaydi).
 *
 * Kuryer tarifi bu yerga `engine`siz keladi — u kuryer profilidan, o'zgarmaydi.
 */
export function resolveOrderTariffDetailed(params: {
  /** Per-order snapshot/override (`order.market_tariff` / `courier_tariff`). */
  snapshot: number | null | undefined;
  /** True when the order is delivered to a center (vs the customer's address). */
  isCenter: boolean;
  centerTariff: number | null | undefined;
  homeTariff: number | null | undefined;
  /** KmWO9gTA: faqat MARKET oyog'i va faqat dvigatel yoqilgan bo'lsa. */
  engine?: SaleEngineQuote | null;
  /** KmWO9gTA floor: kuryer + filial ulushi (faqat `engine` bilan ishlaydi). */
  sharesFloor?: number | null;
}): MarketTariffResolution {
  const standard = toNullableNumber(
    params.isCenter ? params.centerTariff : params.homeTariff,
  );
  if (params.snapshot != null) {
    const tariff = Number(params.snapshot);
    return {
      tariff,
      source: 'snapshot',
      standard,
      base: tariff,
      surcharge: 0,
      computed: tariff,
      floor: 0,
      floorApplied: false,
    };
  }
  if (!params.engine) {
    const tariff = Number(
      (params.isCenter ? params.centerTariff : params.homeTariff) ?? 0,
    );
    return {
      tariff,
      source: 'profile',
      standard,
      base: tariff,
      surcharge: 0,
      computed: tariff,
      floor: 0,
      floorApplied: false,
    };
  }
  const base = standard ?? Math.max(Number(params.engine.tableBase) || 0, 0);
  const surcharge = Math.max(Number(params.engine.surcharge) || 0, 0);
  const computed = round2(base + surcharge);
  const floor = round2(
    Math.max(
      Math.max(Number(params.sharesFloor) || 0, 0),
      Math.max(Number(params.engine.minDeliveryPrice) || 0, 0),
    ),
  );
  const floorApplied = computed < floor;
  return {
    tariff: floorApplied ? floor : computed,
    source: 'engine',
    standard,
    base,
    surcharge,
    computed,
    floor,
    floorApplied,
  };
}

/**
 * DARVOZALAR (prod xulqi o'zgarmasligi uchun HAMMASI sukut bo'yicha yopiq):
 *   • `SALE_PRICING_ENGINE` — `on` bo'lmaguncha (sukut `off`) hech bir
 *     buyurtma dvigateldan narx olmaydi: market tarifi avvalgidek profildan
 *     (`tariff_home` / `tariff_center`), pul oyoqlari baytma-bayt AYNI.
 *     Ega rejasi (2026-10-19): avval bayroq hamma marketda TRUE holda, lekin
 *     dvigatel ULANMAGAN holda chiqariladi, so'ng dvigatel ulanadi.
 *   • `SALE_PRICING_ENGINE_MARKET_IDS` — bo'sh bo'lmasa dvigatel FAQAT shu
 *     marketlarda (vergul bilan id'lar). Prod'da avval TEST marketda
 *     tekshirish uchun.
 *   • Market `weight_volume_pricing` (identity, sukut TRUE) — FALSE bo'lsa
 *     (kelishuvli market) market tarifi = faqat standart narx, ya'ni hozirgi
 *     xulq.
 */
export interface SalePricingConfig {
  enabled: boolean;
  /** NULL — barcha marketlar; aks holda faqat shu id'lar (canary). */
  marketIds: ReadonlySet<string> | null;
}

export function readSalePricingConfig(
  env: Record<string, string | undefined> = process.env,
): SalePricingConfig {
  const raw = String(env.SALE_PRICING_ENGINE ?? '')
    .trim()
    .toLowerCase();
  const ids = String(env.SALE_PRICING_ENGINE_MARKET_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d{1,18}$/.test(id));
  return {
    enabled: raw === 'on',
    marketIds: ids.length ? new Set(ids) : null,
  };
}

/**
 * Shu market buyurtmasi dvigateldan narx oladimi. `weight_volume_pricing`
 * berilmagan (eski identity javobi) — DB sukuti kabi TRUE.
 */
export function isSalePricingEngineActive(
  config: SalePricingConfig,
  marketId: string | number | null | undefined,
  market: { weight_volume_pricing?: boolean | null } | null | undefined,
): boolean {
  if (!config.enabled) return false;
  const id = String(marketId ?? '').trim();
  if (!id) return false;
  if (config.marketIds && !config.marketIds.has(id)) return false;
  return market?.weight_volume_pricing !== false;
}

/**
 * `logistics.delivery.sale_quote` javobi → market oyog'iga kerakli qism.
 * Sotuv va hamkor tarifi uchun bitta moslash.
 */
export function toSaleEngineQuote(quote: {
  extra: number;
  base_price: number;
  min_delivery_price: number | null;
}): SaleEngineQuote {
  return {
    surcharge: quote.extra,
    tableBase: quote.base_price,
    minDeliveryPrice: quote.min_delivery_price,
  };
}
