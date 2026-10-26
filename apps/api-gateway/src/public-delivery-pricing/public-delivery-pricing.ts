/**
 * mSkzzNBJ — ochiq (tokensiz) yetkazish narxi: sof yordamchilar (Nest'siz,
 * alohida test qilinadi).
 *
 * HISOB BU YERDA EMAS: `POST /public/delivery-quote` logistics-service'ning
 * O'SHA `logistics.delivery.quote` RPC'sini chaqiradi (u esa `@app/common`
 * `computeDeliveryQuote` — yagona sof funksiya). Bu fayl faqat:
 *   - ochiq so'rovni RPC payload'iga XAVFSIZ aylantiradi (`product_id` va
 *     `requester` hech qachon ketmaydi — catalog'dagi begona mahsulot
 *     o'lchovi sizmasin);
 *   - javobdan faqat HISOBLANGAN narxni qoldiradi (tarif qatori id'si,
 *     `settings_id`, `valid_from`, viloyat id'lari, mahsulot id'lari — yo'q);
 *   - qisqa TTL kesh va per-IP limit sozlamasi.
 */

// ------------------------------------------------------------ rate limit

/** Musbat butun son; bo'sh yoki noto'g'ri qiymatda — sukut. */
const positiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

/** Manfiy bo'lmagan butun son (0 — o'chirilgan); noto'g'ri qiymatda — sukut. */
const nonNegativeIntEnv = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

export const PUBLIC_PRICING_THROTTLE_LIMIT_DEFAULT = 30;

/**
 * Ochiq narx route'lari uchun QATTIQROQ per-IP limit (`CF-Connecting-IP`,
 * `ClientIpThrottlerGuard`; har route o'z hisoblagichi bilan).
 * `PUBLIC_PRICING_THROTTLE_LIMIT` (sukut 30/daqiqa) — global
 * `THROTTLE_LIMIT` dan HECH QACHON yuqori emas (ochiq route tokenli
 * route'lardan bo'shroq bo'lib qolmasin). Oyna — `PUBLIC_PRICING_THROTTLE_TTL_MS`,
 * bo'lmasa `THROTTLE_TTL_MS`.
 *
 * Kalkulyator ~300 ms debounce bilan chaqiradi: odam bir daqiqada 30 ta
 * hisobdan ko'pini yozmaydi; ortig'i — 429 (landing zaxira formulaga o'tadi).
 * ⚠️ Kalit — mijoz IP'si: landing API'ni BRAUZERDAN chaqirishi kerak.
 * Cloudflare Worker serverdan chaqirsa barcha tashrifchilar Worker'ning
 * bitta chiqish IP'sini bo'lishadi va limit hammaga birga tushadi.
 *
 * ⚠️ `@Throttle` metama'lumoti klass yuklanganda o'qiladi (Joi sukutidan
 * OLDIN) — shuning uchun to'g'ridan-to'g'ri `process.env`; Joi sxemasidagi
 * sukutlar shu yerdagi bilan AYNI.
 */
export function publicPricingThrottleConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const globalLimit = positiveIntEnv(env.THROTTLE_LIMIT, 60);
  const globalTtl = positiveIntEnv(env.THROTTLE_TTL_MS, 60_000);
  return {
    default: {
      limit: Math.min(
        positiveIntEnv(
          env.PUBLIC_PRICING_THROTTLE_LIMIT,
          PUBLIC_PRICING_THROTTLE_LIMIT_DEFAULT,
        ),
        globalLimit,
      ),
      ttl: positiveIntEnv(env.PUBLIC_PRICING_THROTTLE_TTL_MS, globalTtl),
    },
  };
}

/** `@Throttle(PUBLIC_PRICING_THROTTLE)` — `/public/delivery-*` route'lari. */
export const PUBLIC_PRICING_THROTTLE = publicPricingThrottleConfig();

// ------------------------------------------------------------------ kesh

export const PUBLIC_PRICING_CACHE_TTL_MS_DEFAULT = 30_000;

/**
 * Kesh muddati: `PUBLIC_PRICING_CACHE_TTL_MS` (sukut 30 s; 0 — kesh o'chiq).
 * Admin tarifni o'zgartirsa sayt ko'pi bilan shuncha vaqtdan keyin yangi
 * narxni ko'rsatadi — deploysiz.
 */
export function publicPricingCacheTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.min(
    nonNegativeIntEnv(
      env.PUBLIC_PRICING_CACHE_TTL_MS,
      PUBLIC_PRICING_CACHE_TTL_MS_DEFAULT,
    ),
    10 * 60_000,
  );
}

/**
 * Kichik xotiradagi TTL kesh (har gateway jarayonida o'zi). Bir xil kalitga
 * parallel so'rovlar BITTA RPC'ni kutadi; xato keshlanmaydi. Hajm cheklangan
 * — eng eski yozuv chiqariladi (Map qo'shilish tartibi).
 */
export class PublicPricingCache {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<unknown> }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value as Promise<T>;
    if (hit) this.entries.delete(key);

    const value = load();
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

// --------------------------------------------------------- so'rov → RPC

export interface PublicQuoteItemInput {
  weight_kg?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  volumetric_enabled?: boolean;
  quantity?: number;
}

export interface PublicQuoteInput extends PublicQuoteItemInput {
  from_region_id: string;
  to_region_id: string;
  where_deliver: string;
  items?: PublicQuoteItemInput[];
  express?: boolean;
  pickup?: boolean;
}

/** Bitta posilka maydonlari (yuqori darajada — `items` o'rniga). */
export const PUBLIC_QUOTE_FLAT_FIELDS = [
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'volumetric_enabled',
  'quantity',
] as const;

const pickItem = (raw: PublicQuoteItemInput) => {
  const item: Record<string, number | boolean> = {};
  for (const key of PUBLIC_QUOTE_FLAT_FIELDS) {
    const value = raw[key];
    if (value !== undefined && value !== null) item[key] = value;
  }
  return item;
};

/**
 * Ochiq so'rov → `logistics.delivery.quote` payload'i. Maydonlar AYNAN
 * sanab olinadi (DTO'ni yoyish YO'Q): `product_id`, `*_district_id`,
 * `requester` hech qachon ketmaydi. `pickup: true` → bitta posilkali
 * tashrif (`pickup_count: 1`, landing `quote({ pickup })` bilan AYNI).
 * Natija kesh kaliti uchun ham ishlatiladi — tartib barqaror.
 */
export function toLogisticsQuotePayload(input: PublicQuoteInput) {
  const items = (input.items?.length ? input.items : [input]).map(pickItem);
  return {
    items,
    from_region_id: String(input.from_region_id),
    to_region_id: String(input.to_region_id),
    where_deliver: String(input.where_deliver),
    express: input.express === true,
    pickup_count: input.pickup === true ? 1 : 0,
  };
}

// --------------------------------------------------------- javob → ochiq

/** Javobga chiqadigan hisob maydonlari (`DeliveryQuote` dan). */
export const PUBLIC_QUOTE_FIELDS = [
  'tariffId',
  'base',
  'perExtraKg',
  'daysMin',
  'daysMax',
  'actualKg',
  'volumetricKg',
  'volumetricFromKg',
  'volumetricApplied',
  'billableKg',
  'extraKg',
  'extra',
  'subtotal',
  'expressFee',
  'pickupFee',
  'total',
  'totalWithPickup',
  'basis',
  'missingDimensionItems',
  'estimated',
] as const;

/**
 * Logistics `quote` natijasi → ochiq javob: faqat hisob + `days` (landing
 * `Quote.days` shakli) + `cityRoute`. Tarif/sozlama qatorlari, id'lar,
 * `valid_from` — chiqmaydi.
 */
export function toPublicQuote(data: unknown): Record<string, unknown> {
  const src =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_QUOTE_FIELDS) {
    if (key in src) out[key] = src[key];
  }
  out.days = [src.daysMin ?? null, src.daysMax ?? null];
  const route = src.route as { city_route?: unknown } | undefined;
  out.cityRoute = route?.city_route === true;
  return out;
}

/** Saytda chiziladigan formula sozlamalari (id/created_by/is_active — yo'q). */
export const PUBLIC_SETTINGS_FIELDS = [
  'volumetric_divisor',
  'volumetric_from_kg',
  'first_kg_included',
  'min_billable_kg',
  'billable_step_kg',
  'round_to',
  'pickup_fee',
  'pickup_free_from_count',
  'express_multiplier',
] as const;

export const PUBLIC_TARIFF_FIELDS = [
  'base_price',
  'extra_per_kg',
  'days_min',
  'days_max',
] as const;

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const pickNumbers = (
  src: unknown,
  fields: readonly string[],
): Record<string, number | null> => {
  const row =
    src && typeof src === 'object' ? (src as Record<string, unknown>) : {};
  return Object.fromEntries(
    fields.map((field) => [field, toNumberOrNull(row[field])]),
  );
};

/**
 * `GET /public/delivery-tariffs` javobi: har tarifning HOZIRGI qiymatlari,
 * formula sozlamalari (pickup qoidasi ham) va viloyatlar ro'yxati (landing
 * hudud tanlovi → `*_region_id`). Versiyalar, tarix, `created_by`, filial/
 * logist ma'lumoti — yo'q.
 */
export function toPublicTariffs(params: {
  current: unknown;
  settings: unknown;
  regions: unknown;
}) {
  const current =
    params.current && typeof params.current === 'object'
      ? (params.current as Record<string, unknown>)
      : {};
  const tariffs: Record<string, Record<string, number | null> | null> = {};
  for (const id of ['city', 'center', 'address'] as const) {
    tariffs[id] = current[id]
      ? pickNumbers(current[id], PUBLIC_TARIFF_FIELDS)
      : null;
  }
  const regions = (Array.isArray(params.regions) ? params.regions : [])
    .filter(
      (row): row is Record<string, unknown> => !!row && typeof row === 'object',
    )
    .map((row) => ({
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : '',
      is_city_zone: row.is_city_zone === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    tariffs,
    settings: pickNumbers(params.settings, PUBLIC_SETTINGS_FIELDS),
    regions,
  };
}
