/**
 * SMS kodlash va bo'laklar hisobi (nkhURiKX #4).
 *
 * ⚠️ Frontendda AYNI qoida bor (Elchi-Frontend src/shared/lib/smsSegments.ts) —
 * ikkalasi bir xil test vektorlari bilan sinaladi, aks holda muharrirdagi narx
 * bilan hisobdagi narx farq qiladi. Birini o'zgartirsangiz ikkinchisini ham.
 *
 * - GSM-7: bitta SMS 160 septet, ko'p bo'lakli xabarda har bo'lak 153.
 *   Kengaytma jadvali belgilari (^ { } [ ] ~ | \ € va form feed) 2 septet.
 * - UCS-2: matnda GSM-7 ga sig'maydigan BITTA belgi (kirill, ё, o‘ dagi ‘,
 *   emoji) butun xabarni UCS-2 ga o'tkazadi: 70 / ko'p bo'lakda 67 (UTF-16
 *   birlik; emoji = 2 birlik).
 * - Belgi (kengaytma juftligi yoki surrogate juftlik) ikki bo'lakka
 *   bo'linmaydi — sig'masa keyingi bo'lakka o'tadi.
 */

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegments {
  encoding: SmsEncoding;
  /** GSM-7 da septetlar, UCS-2 da UTF-16 birliklar soni. */
  units: number;
  parts: number;
  /** Joriy rejimda bitta bo'lak sig'imi (160/153 yoki 70/67). */
  perPart: number;
}

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '\f^{}\\[~]|€';

const BASIC = new Set(Array.from(GSM7_BASIC));
const EXTENSION = new Set(Array.from(GSM7_EXTENSION));

const LIMITS = {
  'GSM-7': { single: 160, multi: 153 },
  'UCS-2': { single: 70, multi: 67 },
} as const;

export const isGsm7 = (text: string): boolean =>
  Array.from(text).every((ch) => BASIC.has(ch) || EXTENSION.has(ch));

/** Har belgining "og'irligi" — bo'linmas birliklar. */
const widths = (text: string, encoding: SmsEncoding): number[] =>
  Array.from(text).map((ch) =>
    encoding === 'GSM-7' ? (EXTENSION.has(ch) ? 2 : 1) : ch.length,
  );

const pack = (items: number[], capacity: number): number => {
  let parts = 1;
  let used = 0;
  for (const width of items) {
    if (used + width > capacity) {
      parts += 1;
      used = 0;
    }
    used += width;
  }
  return parts;
};

export function countSmsSegments(text: string): SmsSegments {
  const encoding: SmsEncoding = isGsm7(text) ? 'GSM-7' : 'UCS-2';
  const items = widths(text, encoding);
  const units = items.reduce((sum, width) => sum + width, 0);
  const limit = LIMITS[encoding];
  if (units === 0) return { encoding, units, parts: 0, perPart: limit.single };
  if (units <= limit.single) {
    return { encoding, units, parts: 1, perPart: limit.single };
  }
  return {
    encoding,
    units,
    parts: pack(items, limit.multi),
    perPart: limit.multi,
  };
}
