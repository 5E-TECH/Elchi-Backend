import { normalizeUzPhone } from '@app/common';

/** +998XXXXXXXXX yoki null (O'zbek mobil raqami emas). */
export const normalizeSmsPhone = (input: unknown): string | null =>
  normalizeUzPhone(input);

/** Jurnal uchun maska: +998901237434 → ***7434. To'liq raqam logga tushmaydi. */
export const maskPhone = (phone: string | null | undefined): string => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
};

/** Webhook/env qiymatini xavfsiz matnga: faqat string/number/boolean, qolgani ''. */
export const asText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? String(value)
    : '';
