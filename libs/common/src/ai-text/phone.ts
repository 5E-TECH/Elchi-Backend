/**
 * O'zbekiston telefon raqamini yagona `+998XXXXXXXXX` ko'rinishiga keltirish.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) `normalizePhone`
 * :1926-1948. Farqi: mos kelmasa `undefined` emas, `null` qaytaradi va
 * kirishi `unknown` (AI JSON'idan har xil tip kelishi mumkin).
 *
 * AI, Telegram va WebApp yo'llari shu BITTA helperni ishlatadi. Yakuniy
 * darvoza — ai-confirm DTO'sidagi `^\+998\d{9}$` regex; bu funksiya
 * preview'ga to'g'ri raqamni tayyorlaydi.
 */

/**
 * Probel, qavs, defis, nuqta va `+` ni tashlab, quyidagi shakllarni qabul
 * qiladi:
 *   - `998` + 9 raqam (12 raqam): "+998 (90) 123-45-67", "998901234567";
 *   - `0` yoki `8` trunk prefiksi + 9 raqam (10 raqam): "0901234567",
 *     "8 90 123 45 67";
 *   - 9 raqam (milliy raqam): "90 123 45 67" — frontend formasi
 *     (`/^\d{9}$/` + `+998${phone}`) bilan bir xil qoida.
 * Natija `'+998XXXXXXXXX'`, aks holda `null`.
 *
 * ⚠️ HECH QACHON "tuzatmaydi": 8 raqamli raqamga raqam qo'shib TO'LDIRMAYDI,
 * 13 raqamlini KESMAYDI. Buzuq raqam jimgina boshqa odamning raqamiga
 * aylanib qolmasin — null bo'lsa preview uni `phone_invalid` deb belgilaydi
 * va operator o'zi to'g'rilaydi. (Frontend `shared/lib/phone.ts` dagi
 * `slice(0, 9)` kesishi ATAYLAB bu yerga ko'chirilmagan.)
 */
export function normalizeUzPhone(input: unknown): string | null {
  if (typeof input === 'number') {
    // Raqam ko'rinishida kelgan telefon (masalan 998901234567) — faqat
    // manfiy bo'lmagan butun son.
    if (!Number.isSafeInteger(input) || input < 0) return null;
  } else if (typeof input !== 'string') {
    return null;
  }
  let digits = String(input).replace(/\D/g, '');
  // Davlat kodi (998...) yoki trunk prefiks (0.../8...) — milliy 9 raqamga
  // keltiramiz.
  if (digits.length === 12 && digits.startsWith('998')) {
    digits = digits.slice(3);
  } else if (
    digits.length === 10 &&
    (digits.startsWith('0') || digits.startsWith('8'))
  ) {
    digits = digits.slice(1);
  }
  return /^\d{9}$/.test(digits) ? `+998${digits}` : null;
}
