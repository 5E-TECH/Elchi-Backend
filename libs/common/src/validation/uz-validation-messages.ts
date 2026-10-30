/**
 * (ZDweRm02) class-validator'ning inglizcha xabarlari → o'zbekcha. Masalan
 * `name must be longer than or equal to 2 characters` →
 * `name: kamida 2 belgi bo'lishi kerak`.
 *
 * Faqat quyidagi andozalar tarjima qilinadi: class-validator'ning standart
 * matnlari va DTO'lardagi bir nechta inglizcha `{ message }`. Boshqa maxsus
 * xabar andozaga mos kelmaydi va O'ZGARMAYDI. Maydon nomi va ichma-ich yo'l
 * (`items.0.name`) saqlanadi: FE ba'zi xatolarni maydon nomidan taniydi
 * (masalan `/scheduled_at/`). Javob konverti o'zgarmaydi.
 */
type Rule = [RegExp, (...groups: string[]) => string];

const RULES: readonly Rule[] = [
  [
    /^property (.+) should not exist$/,
    (field) => `${field}: bunday maydon qabul qilinmaydi`,
  ],
  [
    /^(.+) must be longer than or equal to (\d+) and shorter than or equal to (\d+) characters$/,
    (field, min, max) =>
      `${field}: ${min} dan ${max} gacha belgi bo'lishi kerak`,
  ],
  [
    /^(.+) must be longer than or equal to (\d+) characters$/,
    (field, min) => `${field}: kamida ${min} belgi bo'lishi kerak`,
  ],
  [
    /^(.+) must be shorter than or equal to (\d+) characters$/,
    (field, max) => `${field}: ko'pi bilan ${max} belgi bo'lishi kerak`,
  ],
  [
    /^(.+) should not be empty$/,
    (field) => `${field}: bo'sh bo'lmasligi kerak`,
  ],
  [/^(.+) should not be null or undefined$/, (field) => `${field}: majburiy`],
  [/^(.+) must be a string$/, (field) => `${field}: matn bo'lishi kerak`],
  [
    /^(.+) must be a number conforming to the specified constraints$/,
    (field) => `${field}: son bo'lishi kerak`,
  ],
  [
    /^(.+) must be an integer number$/,
    (field) => `${field}: butun son bo'lishi kerak`,
  ],
  [
    /^(.+) must be a positive number$/,
    (field) => `${field}: musbat son bo'lishi kerak`,
  ],
  [
    /^(.+) must be a negative number$/,
    (field) => `${field}: manfiy son bo'lishi kerak`,
  ],
  [
    /^(.+) must be a number string$/,
    (field) => `${field}: raqamli satr bo'lishi kerak`,
  ],
  [
    /^(.+) must not be less than (\S+)$/,
    (field, min) => `${field}: kamida ${min} bo'lishi kerak`,
  ],
  [
    /^(.+) must not be greater than (\S+)$/,
    (field, max) => `${field}: ko'pi bilan ${max} bo'lishi kerak`,
  ],
  [
    /^(.+) must be a boolean value$/,
    (field) => `${field}: true yoki false bo'lishi kerak`,
  ],
  [
    /^(.+) must be one of the following values: (.*)$/,
    (field, values) =>
      `${field}: quyidagilardan biri bo'lishi kerak: ${values}`,
  ],
  [
    /^(.+) must be a valid enum value$/,
    (field) => `${field}: ruxsat etilmagan qiymat`,
  ],
  [
    /^(.+) must be a valid phone number$/,
    (field) => `${field}: telefon raqami noto'g'ri`,
  ],
  [/^(.+) must be an email$/, (field) => `${field}: email noto'g'ri`],
  [
    /^(.+) must be a URL address$/,
    (field) => `${field}: havola (URL) noto'g'ri`,
  ],
  [/^(.+) must be a UUID$/, (field) => `${field}: UUID bo'lishi kerak`],
  [
    /^(.+) must be a valid ISO 8601 date string$/,
    (field) => `${field}: sana (ISO 8601) bo'lishi kerak`,
  ],
  [
    /^(.+) must be a Date instance$/,
    (field) => `${field}: sana bo'lishi kerak`,
  ],
  [
    /^(.+) must match (.+) regular expression$/,
    (field) => `${field}: formati noto'g'ri`,
  ],
  [/^(.+) must be an array$/, (field) => `${field}: ro'yxat bo'lishi kerak`],
  [/^(.+) must be an object$/, (field) => `${field}: obyekt bo'lishi kerak`],
  [
    /^(.+) must contain at least (\d+) elements$/,
    (field, min) => `${field}: kamida ${min} ta element bo'lishi kerak`,
  ],
  [
    /^(.+) must contain no more than (\d+) elements$/,
    (field, max) => `${field}: ko'pi bilan ${max} ta element bo'lishi kerak`,
  ],
  [
    /^All (.+)'s elements must be unique$/,
    (field) => `${field}: elementlar takrorlanmasligi kerak`,
  ],
  [
    /^(.+) must be a json string$/,
    (field) => `${field}: JSON satr bo'lishi kerak`,
  ],
  [
    /^(.+) must be a latitude,longitude string$/,
    (field) => `${field}: "kenglik,uzunlik" ko'rinishida bo'lishi kerak`,
  ],
  [
    /^(.+) must be equal to (.+)$/,
    (field, value) => `${field}: ${value} ga teng bo'lishi kerak`,
  ],
  [
    /^nested property (.+) must be either object or array$/,
    (field) => `${field}: obyekt yoki ro'yxat bo'lishi kerak`,
  ],
  [/^(.+) must not be empty$/, (field) => `${field}: bo'sh bo'lmasligi kerak`],
  [
    /^(.+) should not be one of the following values: (.*)$/,
    (field, values) => `${field}: bu qiymatlar mumkin emas: ${values}`,
  ],
  // DTO'lardagi inglizcha `{ message }` (har DTO'ni alohida o'zgartirmaslik uchun).
  [
    /^(.+) must be a bigint-like numeric string$/,
    (field) => `${field}: raqamli bo'lishi kerak`,
  ],
  [
    /^(.+) must be a positive integer$/,
    (field) => `${field}: musbat butun son bo'lishi kerak`,
  ],
  [
    /^(.+) must be an https URL$/,
    (field) => `${field}: https manzil bo'lishi kerak`,
  ],
  [
    /^(.+) must be either center or address$/,
    (field) => `${field}: center yoki address bo'lishi kerak`,
  ],
];

/**
 * Nest ichma-ich DTO xatosiga ota yo'lni oldiga qo'shadi (`items.0.name …`,
 * `customer.property foo …`, `items.0.each value in tags …`), `each: true`
 * esa `each value in ` qo'shadi. Ikkalasi ajratiladi, andoza qolgan qismga
 * qo'llanadi.
 */
const MESSAGE_PARTS = /^((?:[^\s.]+\.)*)(each value in )?([\s\S]*)$/;

/**
 * Bitta xabar. Andozaga mos kelmasa — o'zgarishsiz (maxsus / allaqachon
 * o'zbekcha xabar). `each: true` xabarlari (`each value in tags must be a
 * string`) — `tags (har bir qiymat): matn bo'lishi kerak`.
 */
export function translateValidationMessage(message: unknown): string {
  const text =
    typeof message === 'string'
      ? message
      : typeof message === 'number'
        ? String(message)
        : '';
  const [, path = '', each, body = ''] = MESSAGE_PARTS.exec(text) ?? [];
  for (const [pattern, render] of RULES) {
    const match = pattern.exec(body);
    if (!match) continue;
    const [, field, ...rest] = match;
    return render(`${path}${field}${each ? ' (har bir qiymat)' : ''}`, ...rest);
  }
  return text;
}

/** ValidationPipe xabarlari ro'yxati (`message: string[]`). */
export function translateValidationMessages(messages: unknown[]): string[] {
  return messages.map(translateValidationMessage);
}
