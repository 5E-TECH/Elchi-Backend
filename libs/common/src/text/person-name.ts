import { Roles } from '../../enums';

/**
 * ODAM ISMI — har so'zning BIRINCHI HARFI katta (ega qarori 2026-11-04).
 *
 * «Ism so'ragan har qanday joyda birinchi harf katta bo'lsin — kichik
 * kiritsak ham katta bo'lsin». Faqat odam ismlari: mijoz (qabul qiluvchi)
 * va xodim rollari (superadmin, admin, menejer, registrator, logist, kuryer,
 * investor, market operatori, filial xodimlari). Market (biznes) nomi,
 * mahsulot, filial, viloyat nomlari, izoh va manzilga QO'LLANMAYDI.
 *
 * Qoida:
 *  - boshidagi/oxiridagi bo'shliq olib tashlanadi, ketma-ket bo'shliqlar
 *    bitta probelga aylanadi;
 *  - so'zlar bo'shliq va defis bo'yicha ajratiladi
 *    («abdulla-ugli» → «Abdulla-Ugli»);
 *  - so'zning birinchi HARFI katta qilinadi (oldidagi qo'shtirnoq, qavs kabi
 *    harf bo'lmagan belgilar o'tkazib yuboriladi), qolgan qismi AYNAN
 *    kiritilganidek qoladi: «ali valiyev» → «Ali Valiyev», «o'tkir» →
 *    «O'tkir», «ALI» → «ALI», «mcDonald» → «McDonald», «иван петров» →
 *    «Иван Петров»;
 *  - `toUpperCase` lokalga bog'liq emas (turkcha nuqtasiz «ı» kutilmagan
 *    natija bermaydi).
 *
 * Eski yozuvlar ko'chirilmaydi — faqat yangi yoki tahrirlangan ism.
 * Elchi-Frontend'da ham ayni qoida (`src/shared/lib/`).
 */

/**
 * Nomi ODAM ISMI bo'lmagan rollar: market (biznes nomi) va eski filial
 * hisobi (`branch` — «Filial (eski rol)», nomi filial nomi). Qolgan hamma
 * rol (xodimlar, mijoz) — odam. Elchi-Frontend `isPersonNameRole` bilan
 * ayni ro'yxat.
 */
const BUSINESS_NAME_ROLES: ReadonlySet<string> = new Set<string>([
  Roles.MARKET,
  Roles.BRANCH,
]);

/** Shu roldagi foydalanuvchi nomi odam ismimi (`normalizePersonName` qo'llanadimi). */
export const isPersonNameRole = (role: string | null | undefined): boolean =>
  !BUSINESS_NAME_ROLES.has(String(role ?? ''));

/** So'z ajratkichlari — probel va defis (split natijasida saqlanadi). */
const WORD_SEPARATOR = /([ -])/;

/**
 * So'zning birinchi harfi. Modifikator harflar (`\p{Lm}`: «ʻ», «ʼ») harf
 * hisoblanmaydi — «ʻali» da katta bo'ladigan harf «a».
 */
const FIRST_LETTER = /[^\P{L}\p{Lm}]/u;

const capitalizeWord = (word: string): string => {
  const match = FIRST_LETTER.exec(word);
  if (!match) return word;
  const letter = match[0];
  return (
    word.slice(0, match.index) +
    letter.toUpperCase() +
    word.slice(match.index + letter.length)
  );
};

/**
 * Ismni yuqoridagi qoida bo'yicha keltiradi. Matn bo'lmagan qiymat (RMQ
 * payloadi validatsiya qilinmaydi: `undefined`, `null`, son) O'ZGARISHSIZ
 * qaytadi — chaqiruvchining avvalgi xulqi buzilmasin.
 */
export function normalizePersonName(value: string): string;
export function normalizePersonName<T>(value: T): T;
export function normalizePersonName(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(WORD_SEPARATOR)
    .map(capitalizeWord)
    .join('');
}
