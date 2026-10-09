/**
 * Telegram `parse_mode: 'HTML'` uchun matnni xavfsiz qiladi (OA16fdSq).
 *
 * Telegram HTML rejimida FAQAT `<`, `>`, `&` (va atribut ichida `"`) maxsus —
 * escape qilinmagan `<`/`&` bo'lsa API butun xabarni "can't parse entities"
 * bilan RAD ETADI. `*`, `_`, `` ` `` HTML rejimida oddiy belgi (Markdown'dagi
 * kabi formatlamaydi), shuning uchun ularga tegilmaydi.
 *
 * ⚠️ BeePost Markdown ishlatadi (bot.service.ts:89-91), Elchi — HTML. BeePost
 * matnlari ko'chirilganda `*qalin*` → `<b>qalin</b>` qilinsin va har bir
 * foydalanuvchi kiritgan qism (mijoz ismi, manzil, izoh) shu funksiyadan
 * o'tsin.
 */
export function escapeTelegramHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'boolean'
          ? String(value)
          : '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
