import { normalizePersonName, normalizeUzPhone } from '@app/common';

/**
 * «Tashqi saytlar» importi: mijoz kartasi identity `users` ustunlariga SIG'SIN.
 *
 * Sig'magan qiymat `identity.customer.create` ni yiqitadi; import tsikli
 * bittalab ketgani uchun partiya yarim yo'lda uzilardi. Sig'adigan qiymat
 * O'ZGARMAYDI — keltirish (bosh harf, bo'shliq) identity'ning ishi.
 */

/** `users.name` — varchar(100). */
const NAME_MAX = 100;
/** `users.address` — varchar(255). */
const ADDRESS_MAX = 255;
/** `users.extra_number` — varchar(20). */
const EXTRA_NUMBER_MAX = 20;

/** Postgres kabi belgilar bo'yicha (surrogat juftlik bo'linmasin). */
const cut = (text: string, max: number): string =>
  Array.from(text).slice(0, max).join('');

const isText = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';

/** Identity keltiradigan shakli sig'masa — kesiladi. */
export function fitCustomerName(name: string): string {
  const normalized = normalizePersonName(name);
  return Array.from(normalized).length > NAME_MAX
    ? cut(normalized, NAME_MAX)
    : name;
}

/** Kartada kesiladi; buyurtmaning o'zida manzil to'liq qoladi. */
export function fitCustomerAddress(
  value: unknown,
): string | number | undefined {
  if (!isText(value)) return undefined;
  return typeof value === 'string' ? cut(value, ADDRESS_MAX) : value;
}

/**
 * Raqam KESILMAYDI — boshqa odamning raqami chiqib qolardi. Uzun yozuv bitta
 * raqam bo'lsa («+998 (90) 111 - 22 - 33») kanonik shakli, aks holda yo'q.
 */
export function fitExtraNumber(value: unknown): string | number | undefined {
  if (!isText(value)) return undefined;
  return String(value).length <= EXTRA_NUMBER_MAX
    ? value
    : (normalizeUzPhone(value) ?? undefined);
}
