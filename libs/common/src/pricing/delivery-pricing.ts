/**
 * DAqXPeSy — YETKAZISH NARXI DVIGATELI (sof funksiya).
 *
 * Yagona hisob manbai: logistics-service (`logistics.delivery.quote`), sotuv
 * oqimi (KmWO9gTA), ochiq kalkulyator (mSkzzNBJ) va hamkor tarifi (6tGZzupr)
 * SHU funksiyani chaqiradi — ikkinchi nusxa yozilmaydi. DB'siz, I/O'siz
 * (`apps/order-service/src/domain/order-money.ts` naqshi): o'qish servisda,
 * hisob shu yerda.
 *
 * FORMULA — elchipochta.uz dagi tasdiqlangan `lib/pricing.ts` `quote()` bilan
 * AYNI (landing origin/main 3697d84; 13 oltin vektor `delivery-pricing.spec.ts`
 * da AYNAN ko'chirilgan):
 *   1. hajmli vazn = U × K × B / `volumetric_divisor` (5000);
 *   2. hisob vazni = max( yuqoriga(max(haqiqiy, hajmli), `billable_step_kg`),
 *      `min_billable_kg` ) — 0.1 kg qadam bilan YUQORIGA, kamida 0.1 kg;
 *   3. qo'shimcha kg = max(0, yuqoriga(hisob vazni − `first_kg_included` − EPS))
 *      — birinchi kg bazaga kiradi;
 *   4. subtotal = baza + qo'shimcha kg × kg narxi;
 *   5. express = subtotal × (`express_multiplier` − 1);
 *   6. total = round((subtotal + express) / `round_to`) × `round_to` (500).
 * Hech qanday biznes soni kodga qotirilmagan — hammasi `settings` va
 * `tariff` dan (logistics_schema.delivery_pricing_settings / delivery_tariffs).
 *
 * QULFLANGAN QARORLAR (Shodiyor, 2026-10-15):
 *   - ko'p mahsulotli buyurtma = BITTA jo'natma: og'irliklar va hajmlar
 *     QO'SHILADI (× quantity), baza BIR MARTA olinadi;
 *   - `volumetric_enabled = false` element hajmi yig'indiga KIRMAYDI, og'irligi
 *     kiradi;
 *   - o'lchamsiz element (L/W/H NULL): hajm komponenti 0, faqat og'irlik
 *     (`missingDimensionItems` da sanaladi);
 *   - og'irligi NULL element 0 kg deb HISOBLANMAYDI: `unmeasuredItems` > 0 va
 *     `estimated: true` — narx jimgina 0 ga tushmaydi, kamida baza tarif
 *     (yakuniy sotuv darvozasi KmWO9gTA da);
 *   - PICKUP buyurtma narxiga QO'SHILMAYDI: u bitta TASHRIFGA tegishli
 *     (1–9 posilka → `pickup_fee`, `pickup_free_from_count`+ → 0) va market
 *     hisobiga alohida yoziladi (B824gOu5). `pickupFee` alohida qaytadi;
 *     `total` — buyurtmaga YOZILADIGAN yetkazish narxi (pickup'siz);
 *     `totalWithPickup` — saytdagi kalkulyator jami (landing `quote().total`
 *     bilan AYNI: pickup bitta yaxlitlashga kiradi).
 *
 * ANIQLIK: og'irlik grammda (`numeric(10,3)` — butun gramm), hajm sm³ da,
 * pul tiyinda — butun sonlar arifmetikasi. Landing'dagi suzuvchi nuqta
 * chiqindisi (2.0000000000000004 kg → ortiqcha kg) bu yerda ko'p elementli
 * yig'indida ham paydo bo'lmaydi; EPS landing bilan moslik uchun saqlangan.
 * `total` 500 ga yaxlitlangan — bu YOZILADIGAN qiymat; UI qayta yaxlitlamaydi.
 */

/** Tarif kodlari — `logistics_schema.delivery_tariffs.tariff_id` CHECK bilan AYNI. */
export const DELIVERY_TARIFF_IDS = ['city', 'center', 'address'] as const;
export type DeliveryTariffId = (typeof DELIVERY_TARIFF_IDS)[number];

/** Toshkent shahri tashqarisidagi yetkazish turi — `Where_deliver` enum bilan AYNI. */
export const DELIVERY_WHERE_DELIVER_IDS = ['center', 'address'] as const;
export type DeliveryWhereDeliver = (typeof DELIVERY_WHERE_DELIVER_IDS)[number];

/**
 * Suzuvchi nuqta chiqindisi uchun (landing `pricing.ts:89-90`). Butun sonli
 * arifmetikada natijaga ta'sir qilmaydi — faqat himoya.
 */
const EPS = 1e-9;

type Numeric = number | string | null | undefined;

export interface DeliveryPricingItem {
  weight_kg?: Numeric;
  length_cm?: Numeric;
  width_cm?: Numeric;
  height_cm?: Numeric;
  /** Sukut — true (catalog `volumetric_enabled` DEFAULT true). */
  volumetric_enabled?: boolean | null;
  /** Sukut — 1. Butun son ≥ 1. */
  quantity?: Numeric;
}

export interface DeliveryTariffRate {
  tariff_id: string;
  base_price: Numeric;
  extra_per_kg: Numeric;
  days_min?: Numeric;
  days_max?: Numeric;
}

export interface DeliveryPricingSettingsValues {
  volumetric_divisor: Numeric;
  first_kg_included: Numeric;
  min_billable_kg: Numeric;
  billable_step_kg: Numeric;
  round_to: Numeric;
  pickup_fee: Numeric;
  /** NULL — pickup hech qachon tekin bo'lmaydi. */
  pickup_free_from_count?: Numeric;
  express_multiplier: Numeric;
}

export interface DeliveryQuoteInput {
  items: ReadonlyArray<DeliveryPricingItem>;
  tariff: DeliveryTariffRate;
  settings: DeliveryPricingSettingsValues;
  express?: boolean;
  /**
   * Bitta pickup tashrifidagi posilkalar soni (0 / berilmasa — pickup yo'q).
   * Landing `pickup: true` ≡ `pickupCount: 1`.
   */
  pickupCount?: Numeric;
}

export interface DeliveryQuote {
  tariffId: string;
  /** Tarifning 1-kg gacha narxi (baza). */
  base: number;
  perExtraKg: number;
  daysMin: number | null;
  daysMax: number | null;
  /** Haqiqiy og'irliklar yig'indisi, kg (o'lchovli elementlar). */
  actualKg: number;
  /** Hajmli vazn yig'indisi, kg (faqat `volumetric_enabled` va o'lchamli). */
  volumetricKg: number;
  /** Hisob vazni, kg (0.1 kg qadam, minimum bilan). */
  billableKg: number;
  /** Bazadan ortiq to'liq kg soni. */
  extraKg: number;
  /** extraKg × perExtraKg, so'm. */
  extra: number;
  /** base + extra, so'm. */
  subtotal: number;
  expressFee: number;
  /** Pickup tashrifi haqi — `total` ga KIRMAYDI. */
  pickupFee: number;
  /** Buyurtmaga yoziladigan yetkazish narxi (round_to ga karrali, pickup'siz). */
  total: number;
  /** Kalkulyator jami: round(subtotal + express + pickup) — landing `total`. */
  totalWithPickup: number;
  /** Narx qaysi vazndan chiqdi; hech narsa o'lchanmagan bo'lsa — null. */
  basis: 'weight' | 'volume' | null;
  /** Og'irligi yo'q elementlar (qatorlar) soni. */
  unmeasuredItems: number;
  /** Hajm hisobi yoqiq, lekin L/W/H to'liq emas — hajm 0 olingan qatorlar. */
  missingDimensionItems: number;
  /** unmeasuredItems > 0 yoki missingDimensionItems > 0 — narx taxminiy. */
  estimated: boolean;
}

/** Kirish noto'g'ri (manfiy o'lcham, 0 bo'luvchi va h.k.) — jim 0 o'rniga xato. */
export class DeliveryPricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryPricingInputError';
  }
}

function toNumberOrNull(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function requireNumber(
  value: Numeric,
  field: string,
  check: (n: number) => boolean,
  rule: string,
): number {
  const n = toNumberOrNull(value);
  if (n === null || Number.isNaN(n) || !check(n)) {
    throw new DeliveryPricingInputError(`${field} — ${rule}`);
  }
  return n;
}

/** Ixtiyoriy musbat son: null — yo'q; 0, manfiy, son emas — xato. */
function optionalPositive(value: Numeric, field: string): number | null {
  const n = toNumberOrNull(value);
  if (n === null) return null;
  if (Number.isNaN(n) || n <= 0) {
    throw new DeliveryPricingInputError(
      `${field} — musbat son yoki bo'sh bo'lishi kerak`,
    );
  }
  return n;
}

const toTiyin = (som: number): number => Math.round(som * 100);
const fromTiyin = (tiyin: number): number => tiyin / 100;
const toGrams = (kg: number): number => Math.round(kg * 1000);

/**
 * Yo'nalish qaysi tarifga tushadi (landing `resolveTariff`): ikkala uchi ham
 * shahar zonasida (`regions.is_city_zone`) — `city`, aks holda yetkazish turi.
 * Toshkent VILOYATI shahar zonasi EMAS (08.10.2026 qarori).
 */
export function resolveDeliveryTariffId(params: {
  fromCityZone: boolean;
  toCityZone: boolean;
  whereDeliver: string;
}): DeliveryTariffId {
  if (
    !(DELIVERY_WHERE_DELIVER_IDS as readonly string[]).includes(
      params.whereDeliver,
    )
  ) {
    throw new DeliveryPricingInputError(
      "where_deliver — 'center' yoki 'address' bo'lishi kerak",
    );
  }
  return params.fromCityZone && params.toCityZone
    ? 'city'
    : (params.whereDeliver as DeliveryWhereDeliver);
}

/** Yetkazish narxi — sof hisob (yuqoridagi formula). */
export function computeDeliveryQuote(input: DeliveryQuoteInput): DeliveryQuote {
  const { settings, tariff } = input;

  const divisor = requireNumber(
    settings.volumetric_divisor,
    'volumetric_divisor',
    (n) => n > 0,
    "0 dan katta bo'lishi kerak",
  );
  const stepG = toGrams(
    requireNumber(
      settings.billable_step_kg,
      'billable_step_kg',
      (n) => n > 0,
      "0 dan katta bo'lishi kerak",
    ),
  );
  if (stepG < 1) {
    throw new DeliveryPricingInputError(
      "billable_step_kg — kamida 0.001 kg bo'lishi kerak",
    );
  }
  const minBillableG = toGrams(
    requireNumber(
      settings.min_billable_kg,
      'min_billable_kg',
      (n) => n >= 0,
      "manfiy bo'lmasligi kerak",
    ),
  );
  const firstG = toGrams(
    requireNumber(
      settings.first_kg_included,
      'first_kg_included',
      (n) => n >= 0,
      "manfiy bo'lmasligi kerak",
    ),
  );
  const roundToT = toTiyin(
    requireNumber(
      settings.round_to,
      'round_to',
      (n) => n > 0,
      "0 dan katta bo'lishi kerak",
    ),
  );
  const multiplierMilli = Math.round(
    requireNumber(
      settings.express_multiplier,
      'express_multiplier',
      (n) => n >= 1,
      "1 dan kichik bo'lmasligi kerak",
    ) * 1000,
  );
  const pickupFeeT = toTiyin(
    requireNumber(
      settings.pickup_fee,
      'pickup_fee',
      (n) => n >= 0,
      "manfiy bo'lmasligi kerak",
    ),
  );
  const freeFrom = optionalPositive(
    settings.pickup_free_from_count,
    'pickup_free_from_count',
  );

  const baseT = toTiyin(
    requireNumber(
      tariff.base_price,
      'base_price',
      (n) => n >= 0,
      "manfiy bo'lmasligi kerak",
    ),
  );
  const perKgT = toTiyin(
    requireNumber(
      tariff.extra_per_kg,
      'extra_per_kg',
      (n) => n >= 0,
      "manfiy bo'lmasligi kerak",
    ),
  );

  let actualG = 0;
  let volumeCm3 = 0;
  let unmeasuredItems = 0;
  let missingDimensionItems = 0;

  input.items.forEach((item, index) => {
    const label = `items[${index}]`;
    const quantity =
      item.quantity === null || item.quantity === undefined
        ? 1
        : requireNumber(
            item.quantity,
            `${label}.quantity`,
            (n) => Number.isInteger(n) && n >= 1,
            "1 dan katta yoki teng butun son bo'lishi kerak",
          );

    const weight = optionalPositive(item.weight_kg, `${label}.weight_kg`);
    if (weight === null) {
      unmeasuredItems += 1;
    } else {
      actualG += toGrams(weight) * quantity;
    }

    if (item.volumetric_enabled === false) return;
    const dims = [
      optionalPositive(item.length_cm, `${label}.length_cm`),
      optionalPositive(item.width_cm, `${label}.width_cm`),
      optionalPositive(item.height_cm, `${label}.height_cm`),
    ];
    if (dims.some((d) => d === null)) {
      missingDimensionItems += 1;
      return;
    }
    volumeCm3 +=
      (dims[0] as number) *
      (dims[1] as number) *
      (dims[2] as number) *
      quantity;
  });

  const freePickup = (n: number) => freeFrom !== null && n >= freeFrom;
  const pickupCount =
    input.pickupCount === null || input.pickupCount === undefined
      ? 0
      : requireNumber(
          input.pickupCount,
          'pickupCount',
          (n) => Number.isInteger(n) && n >= 0,
          "manfiy bo'lmagan butun son bo'lishi kerak",
        );

  // 0.1 kg qadam bilan YUQORIGA: ceil(max(a, b)) = max(ceil(a), ceil(b)).
  // Hajm: sm³ × 1000 / (bo'luvchi × qadam_g) — bitta bo'lish, butun sonlar.
  const actualSteps = Math.ceil(actualG / stepG);
  const volumeSteps = Math.ceil((volumeCm3 * 1000) / (divisor * stepG));
  const billableG = Math.max(
    Math.max(actualSteps, volumeSteps) * stepG,
    minBillableG,
  );
  const extraKg = Math.max(0, Math.ceil((billableG - firstG) / 1000 - EPS));

  const extraT = extraKg * perKgT;
  const subtotalT = baseT + extraT;
  const expressFeeT = input.express
    ? Math.round((subtotalT * (multiplierMilli - 1000)) / 1000)
    : 0;
  const pickupT = pickupCount > 0 && !freePickup(pickupCount) ? pickupFeeT : 0;
  const roundTo = (tiyin: number) => Math.round(tiyin / roundToT) * roundToT;

  const volumeG = (volumeCm3 * 1000) / divisor;
  const daysMin = toNumberOrNull(tariff.days_min);
  const daysMax = toNumberOrNull(tariff.days_max);

  return {
    tariffId: tariff.tariff_id,
    base: fromTiyin(baseT),
    perExtraKg: fromTiyin(perKgT),
    daysMin: daysMin === null || Number.isNaN(daysMin) ? null : daysMin,
    daysMax: daysMax === null || Number.isNaN(daysMax) ? null : daysMax,
    actualKg: actualG / 1000,
    volumetricKg: Math.round(volumeG) / 1000,
    billableKg: billableG / 1000,
    extraKg,
    extra: fromTiyin(extraT),
    subtotal: fromTiyin(subtotalT),
    expressFee: fromTiyin(expressFeeT),
    pickupFee: fromTiyin(pickupT),
    total: fromTiyin(roundTo(subtotalT + expressFeeT)),
    totalWithPickup: fromTiyin(roundTo(subtotalT + expressFeeT + pickupT)),
    basis:
      actualG === 0 && volumeCm3 === 0
        ? null
        : volumeG > actualG
          ? 'volume'
          : 'weight',
    unmeasuredItems,
    missingDimensionItems,
    estimated: unmeasuredItems > 0 || missingDimensionItems > 0,
  };
}
