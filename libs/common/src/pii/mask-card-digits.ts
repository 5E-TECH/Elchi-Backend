/**
 * AI o'qigan matndan karta raqamini (PAN) yashirish — T3 kassa cheki va
 * kiZgTybn smena skrinshoti uchun BITTA qoida.
 *
 * Raqamlar orasida 0–3 ta harf/raqam bo'lmagan belgi (bo'sh joy, ikki bo'sh
 * joy, `-`, en-dash, ` - `, `/`, `_`, `.`, `,` …) bo'lsa ham bitta ketma-ketlik
 * deb olinadi; undagi raqamlar soni chegaradan oshsa — `***`. Ajratgichni
 * olib tashlash (referens filtri, bo'shliqni yig'ish) hech qachon niqobsiz
 * PAN bermasin.
 */
export const CARD_MASK = '***';
/** Karta raqami / telefon (+998…) — shu qadar raqamli ketma-ketlik. */
export const CARD_LIKE_MIN_DIGITS = 12;

const DIGIT_RUN = /\d(?:[^\p{L}\p{N}]{0,3}\d)*/gu;

const digitCount = (run: string) => run.replace(/\D/g, '').length;

/** `minDigits` dan ko'p raqamli ketma-ketlik → `***`. */
export function maskCardLikeDigits(
  text: string,
  minDigits: number = CARD_LIKE_MIN_DIGITS,
): string {
  return text.replace(DIGIT_RUN, (run) =>
    digitCount(run) >= minDigits ? CARD_MASK : run,
  );
}

/** Matnda shunday ketma-ketlik bormi (referens — niqoblash o'rniga rad). */
export function hasCardLikeDigits(
  text: string,
  minDigits: number = CARD_LIKE_MIN_DIGITS,
): boolean {
  for (const run of text.match(DIGIT_RUN) ?? []) {
    if (digitCount(run) >= minDigits) return true;
  }
  return false;
}

/**
 * Sana-vaqt (`30.10.2026 14.05.33`, `2026-10-30T14:05`, `30/10/26 14:05`) —
 * avval tanib olinadi va o'zgarmaydi; qolgan matndagi karta raqami
 * niqoblanadi.
 */
const DATE_TIME =
  /(?<!\d)(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))(?:(?:[ T]|,\s?)\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)?(?!\d)/g;

export function maskCardLikeDigitsKeepingDates(
  text: string,
  minDigits: number = CARD_LIKE_MIN_DIGITS,
): string {
  // Joy egasi raqamsiz (harf) — atrofdagi raqamlar bilan qo'shilib ketmasin.
  const kept: string[] = [];
  const protectedText = text.replace(DATE_TIME, (match) => {
    if (kept.length >= 26) return match;
    kept.push(match);
    return `\uE000${String.fromCharCode(97 + kept.length - 1)}\uE000`;
  });
  return maskCardLikeDigits(protectedText, minDigits).replace(
    /\uE000([a-z])\uE000/g,
    (_m, letter: string) => kept[letter.charCodeAt(0) - 97] ?? '',
  );
}
