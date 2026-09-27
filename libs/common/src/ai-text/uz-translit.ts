/**
 * Kirill (o'zbek + rus) -> lotin transliteratsiya va diakritik-folding.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `CYR_LATIN` jadvali
 * :32-76 va `translit()` :1905-1917. Mantiq 1:1 ko'chirilgan; faqat private
 * metoddan sof funksiyaga aylantirilgan (DB, tarmoq, Nest DI YO'Q).
 *
 * NEGA: foydalanuvchi (yoki AI) kirillcha ("Андижон"), nostandart lotin
 * ("Kattaqörğon") yoki apostrofli ("Kattaqo'rg'on") yozsa ham DB'dagi lotin
 * nomlar bilan BIR XIL skeletda taqqoslanishi kerak. Har bir holat uchun
 * alohida qoida yozilmaydi — jadval universal.
 */

// Kirill (o'zbek + rus) -> lotin. Kalitlar kichik harf: `translit` avval
// `toLowerCase()` qiladi.
const CYR_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ғ: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  қ: 'q',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ў: 'o',
  ф: 'f',
  х: 'x',
  ҳ: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ә: 'a',
  ө: 'o',
  ү: 'u',
  ҷ: 'j',
  ұ: 'u',
};

/**
 * Apostrof va unga o'xshash belgilar (o'->o, g'->g):
 * U+0060 `, U+02BC ʼ, U+02BB ʻ, U+0027 ', U+2018 ‘, U+2019 ’, U+02B9 ʹ.
 *
 * ⚠️ O'zbek lotinida "o'" va "g'" uchun klaviaturaga qarab 4-5 xil belgi
 * ishlatiladi. Bittasi tushib qolsa "Xoʻjaobod" va "Xo'jaobod" ikki xil nom
 * bo'lib qoladi va tuman topilmaydi.
 */
const APOSTROPHES_RE = /[\u0060\u02bc\u02bb\u0027\u2018\u2019\u02b9]/g;

/**
 * Umumiy transliteratsiya + diakritik-folding — HAR QANDAY yozuvni (kirill,
 * ö/ğ/ş/ç kabi nostandart lotin, apostrofli) yagona kichik-harfli lotin
 * skeletga keltiradi. "Андижон" / "Kattaqörğon" / "Kattaqo'rg'on" bir xil
 * taqqoslanadi.
 *
 * Satr bo'lmagan qiymat (null/undefined yoki AI JSON'idan kelgan boshqa tip)
 * bo'sh satr sifatida qaraladi — funksiya hech qachon xato tashlamaydi.
 */
export function translit(s: string | null | undefined): string {
  const src = (typeof s === 'string' ? s : '').toLowerCase().normalize('NFKC');
  let out = '';
  for (const ch of src) out += CYR_LATIN[ch] ?? ch;
  return out
    .replace(/ş/g, 'sh')
    .replace(/ç/g, 'ch')
    .replace(/ø/g, 'o')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diakritiklar: ö→o, ü→u, ğ→g, é→e...
    .replace(APOSTROPHES_RE, '');
}
