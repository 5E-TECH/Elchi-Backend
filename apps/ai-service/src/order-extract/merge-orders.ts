import {
  AI_EXTRACT_WARNING_FIELDS,
  normalizeUzPhone,
  type AiExtractWarning,
  type RawOrderExtraction,
} from '@app/common';

/**
 * WHMAIqyo #4: bo'laklab (5 tadan rasm) PARALLEL ekstraksiya natijalarini
 * birlashtirish va DUBLIKAT buyurtmalarni olib tashlash.
 *
 * Dublikat qachon: bir xil telefon (normallashgan) VA
 *  - mahsulotlar to'plami bir xil YOKI bir tomonda mahsulot yo'q
 *    (bitta buyurtma ikki bo'lakka bo'linib qolgan: 1-rasmda manzil,
 *    6-rasmda mahsulot), VA
 *  - aniq to'qnashuv YO'Q: ikkala tomonda ham qiymat bor-u, har xil bo'lgan
 *    narx / tuman / viloyat / manzil / yetkazish turi bo'lsa — bu ikki ALOHIDA
 *    buyurtma (o'sha mijozning ikkinchi buyurtmasi), birlashtirilMAYDI.
 * Telefonsiz buyurtma faqat AYNAN bir xil bo'lsa (barcha maydonlar) olinadi.
 *
 * Birlashtirishda bo'sh (null) maydon ikkinchisidan to'ldiriladi, mahsulotlar
 * (bir tomoni bo'sh bo'lsa) olinadi, ogohlantirishlar birlashtiriladi.
 * Sof funksiya: kirishni o'zgartirmaydi, tartib (bo'lak → buyurtma) saqlanadi.
 */
export function mergeExtractedOrders(
  chunks: ReadonlyArray<ReadonlyArray<RawOrderExtraction>>,
): RawOrderExtraction[] {
  const out: RawOrderExtraction[] = [];
  for (const chunk of chunks) {
    for (const order of chunk) {
      const idx = out.findIndex((existing) => isDuplicate(existing, order));
      if (idx === -1) {
        out.push(cloneOrder(order));
      } else {
        out[idx] = mergePair(out[idx], order);
      }
    }
  }
  return out;
}

type ScalarKey = Exclude<keyof RawOrderExtraction, 'items' | 'warnings'>;

const SCALAR_KEYS: readonly ScalarKey[] = [
  'customer_name',
  'phone_number',
  'extra_number',
  'region_name',
  'district_name',
  'address',
  'full_address',
  'total_price',
  'comment',
  'where_deliver',
  'is_replacement',
  'operator',
];

/** Ikkala tomonda qiymat bo'lib, har xil bo'lsa — alohida buyurtma. */
const CONFLICT_KEYS: readonly ScalarKey[] = [
  'total_price',
  'region_name',
  'district_name',
  'address',
  'where_deliver',
];

function norm(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function phoneKey(o: RawOrderExtraction): string | null {
  const raw = o.phone_number ?? o.extra_number;
  if (!raw) return null;
  return normalizeUzPhone(raw) ?? (raw.replace(/\D/g, '') || null);
}

function itemsKey(o: RawOrderExtraction): string {
  return o.items
    .map((it) => `${norm(it.name)}×${it.quantity}`)
    .sort()
    .join('|');
}

function hasConflict(a: RawOrderExtraction, b: RawOrderExtraction): boolean {
  return CONFLICT_KEYS.some((key) => {
    const x = a[key];
    const y = b[key];
    if (x === null || x === undefined || y === null || y === undefined) {
      return false;
    }
    return norm(x) !== norm(y);
  });
}

function isDuplicate(a: RawOrderExtraction, b: RawOrderExtraction): boolean {
  const pa = phoneKey(a);
  const pb = phoneKey(b);
  if (pa === null || pb === null) {
    // Telefonsiz — faqat aynan bir xil buyurtma.
    return (
      pa === pb &&
      itemsKey(a) === itemsKey(b) &&
      SCALAR_KEYS.every((k) => norm(a[k]) === norm(b[k]))
    );
  }
  if (pa !== pb) return false;
  const sameItems = itemsKey(a) === itemsKey(b);
  const oneEmpty = a.items.length === 0 || b.items.length === 0;
  if (!sameItems && !oneEmpty) return false;
  return !hasConflict(a, b);
}

function cloneOrder(o: RawOrderExtraction): RawOrderExtraction {
  return {
    ...o,
    items: o.items.map((it) => ({ ...it })),
    warnings: o.warnings.map((w) => ({ ...w })),
  };
}

function mergeWarnings(
  a: readonly AiExtractWarning[],
  b: readonly AiExtractWarning[],
): AiExtractWarning[] {
  const byField = new Map<string, AiExtractWarning>();
  for (const w of [...a, ...b]) {
    if (!byField.has(w.field)) byField.set(w.field, { ...w });
  }
  return AI_EXTRACT_WARNING_FIELDS.filter((f) => byField.has(f)).map(
    (f) => byField.get(f) as AiExtractWarning,
  );
}

function mergePair(
  a: RawOrderExtraction,
  b: RawOrderExtraction,
): RawOrderExtraction {
  const merged = cloneOrder(a);
  const target = merged as unknown as Record<ScalarKey, unknown>;
  for (const key of SCALAR_KEYS) {
    if (key === 'is_replacement') continue;
    if (target[key] === null || target[key] === undefined) {
      target[key] = b[key];
    }
  }
  merged.is_replacement = a.is_replacement || b.is_replacement;
  if (merged.items.length === 0 && b.items.length > 0) {
    merged.items = b.items.map((it) => ({ ...it }));
  }
  // To'ldirilgan maydon uchun ham ogohlantirish qoldiriladi — bo'laklardan
  // biri uni noaniq deb belgilagan, operator baribir tekshiradi.
  merged.warnings = mergeWarnings(a.warnings, b.warnings);
  return merged;
}
