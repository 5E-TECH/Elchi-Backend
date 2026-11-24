/**
 * «Tashqi saytlar» importi: `items` MATN bo'lib kelganda mahsulot qatorlari.
 *
 * Prod 2026-11-25: Lidershop va Alion `items` ni massiv emas, tayyor matn qilib
 * yuboradi — "Diskali soat x 1 = 99 000 so'm". Ilgari massiv bo'lmagan qiymat
 * butunlay tashlanardi: buyurtma `items = []`, `product_quantity = 0` bo'lib,
 * operator posilka ichida NIMA borligini ko'rmasdi.
 *
 * Elchi-Frontend `src/pages/new_orders/sites/model/siteOrder.ts` (`readItems`)
 * shu qoidaning nusxasi — operator ro'yxatda ko'rgan mahsulot buyurtmaga ham
 * xuddi shunday yozilsin. Qoida o'zgarsa ikkalasi birga o'zgaradi.
 */

export interface ExternalTextItem {
  product_name: string;
  quantity: number;
}

/** `order_items.product_name` — varchar(255): uzunroq nom INSERT'ni yiqitardi. */
const PRODUCT_NAME_MAX = 255;
/** `order_items.quantity` — int4: kattaroq son INSERT'ni yiqitardi. */
const QUANTITY_MAX = 2_147_483_647;

/**
 * Bitta qator: `<nom> x <son> = <summa>`, so'ng vergul / `;` / yangi qator yoki
 * matn oxiri. Bo'shliqlar oldindan bittaga keltirilgan (`normalizeText`).
 *
 *  - `= <summa>` MAJBURIY: usiz "Gilam 2 x 3" (o'lcham) ham son deb o'qilardi.
 *  - Son 1–999: "Soat x 99000 = 99000" da narx son bo'lib ketmasin.
 *  - Nom ichida vergul bo'lishi mumkin ("Soat, qora x 1 = …"); yangi qator va
 *    `;` esa doim qator chegarasi.
 *  - Nom ichida `=` BO'LMAYDI: aks holda ajralmagan oldingi qator keyingisining
 *    nomiga yutilib, uning soni yo'qolardi.
 *  - Summa ichidagi vergul ("99,000 so'm") chegara emas: raqam yopishgan vergul
 *    hech qachon chegara bo'lmaydi.
 *  - Ko'paytirish belgisi — `x` (lotin yoki kirill), `×` yoki `*`.
 *
 * ⚠️ Summa faqat qator tugaganini bilish uchun kerak, qiymati O'QILMAYDI: narx
 * avvalgidek `total_price` / `delivery_price` dan.
 */
const ROW =
  /([^\n;=]+?) [xх×*] ?([1-9]\d{0,2}) ?= ?\d+(?:[ .,]\d{3})*(?:[.,]\d{1,2})?(?: ?(?:so['’‘ʻʼ`´]?m|sum|сум|сўм|сом|uzs|usd|\$)\.?)? ?(?:(?:,(?!\d)|[;\n])[,;\s]*|$)/iuy;

/** Har xil bo'shliq (NBSP ham) bitta bo'shliqqa; yangi qator saqlanadi. */
const normalizeText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();

/** Belgilar bo'yicha (surrogat juftlik bo'linmasin) ustun sig'imiga kesadi. */
const productName = (raw: string): string =>
  Array.from(raw.replace(/\s+/g, ' ').trim())
    .slice(0, PRODUCT_NAME_MAX)
    .join('');

/** `total_count` — musbat butun son (yoki shunday matn), aks holda 1. */
const fallbackQuantity = (totalCount: unknown): number => {
  if (typeof totalCount !== 'number' && typeof totalCount !== 'string') {
    return 1;
  }
  const count = Number(totalCount);
  return Number.isInteger(count) && count > 0 && count <= QUANTITY_MAX
    ? count
    : 1;
};

/** Matn TO'LIQ qatorlarga ajralsa — ular, bir bo'lagi ham qolsa — `null`. */
function parseRows(text: string): ExternalTextItem[] | null {
  const rows: ExternalTextItem[] = [];
  ROW.lastIndex = 0;
  while (ROW.lastIndex < text.length) {
    const match = ROW.exec(text);
    if (!match) return null;
    rows.push({
      product_name: productName(match[1]),
      quantity: Number(match[2]),
    });
  }
  return rows;
}

/**
 * Matndan mahsulot qatorlari. Ishonch bilan ajralmasa — butun matn bitta qator
 * nomi, soni `total_count` (musbat butun son) yoki 1. Harf ham raqam ham yo'q
 * matn ("", "-", "[]") — mahsulot emas, bo'sh ro'yxat.
 */
export function readExternalItemsText(
  raw: string,
  totalCount: unknown,
): ExternalTextItem[] {
  const text = normalizeText(raw);
  if (!/[\p{L}\p{N}]/u.test(text)) return [];
  return (
    parseRows(text) ?? [
      {
        product_name: productName(text),
        quantity: fallbackQuantity(totalCount),
      },
    ]
  );
}
