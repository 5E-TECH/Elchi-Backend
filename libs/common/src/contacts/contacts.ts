import { Roles } from '../../enums';
import { normalizeUzPhone } from '../ai-text';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — umumiy konstantalar, turlar va sof
 * funksiyalar. identity-service (mas'ul / sozlamalar / rezolver) va
 * api-gateway (DTO, xato kodlari, `problem_contacts`, printer) SHU fayldan
 * oladi — kalit, rol va kod nomlari ikki joyda yozilmaydi.
 *
 * Maqsad (ega, 2026-10-29): kuryer va filial menejeri marketga to'g'ridan-
 * to'g'ri qo'ng'iroq qilmaydi — ular viloyat logistiga, market esa o'z Elchi
 * mas'uliga bog'lanadi. Chek/yorliqdagi «Muammo bo'lsa» — buyurtma viloyati
 * logistining raqami (logist yo'q / nofaol — zaxira raqamlar).
 */

/** `identity_schema.app_settings` kalitlari. */
export const CONTACT_SETTING_KEYS = {
  SUPPORT_PHONES: 'contacts.support_phones',
  DEFAULT_MARKET_RESPONSIBLE: 'contacts.default_market_responsible_id',
} as const;

/** Zaxira raqamlar soni chegarasi (0–2). */
export const SUPPORT_PHONES_MAX = 2;

/** `problem_contacts` uzunligi chegarasi. */
export const PROBLEM_CONTACTS_MAX = 2;

/** Super kuryerning «Viloyatingiz logisti» kartasidagi logistlar chegarasi. */
export const MY_CONTACTS_LOGISTS_MAX = 5;

/** Bulk biriktirishda bir so'rovdagi marketlar chegarasi. */
export const RESPONSIBLE_BULK_MAX = 500;

/**
 * Market mas'uli bo'la oladigan rollar (ega qarori: alohida call-markaz roli
 * yo'q). Boshqa rolga o'tgan / o'chirilgan mas'ulning marketlari sukutga
 * qaytadi (identity `releaseResponsible`).
 */
export const MARKET_RESPONSIBLE_ROLES: readonly Roles[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.REGISTRATOR,
  Roles.LOGIST,
];

export const isMarketResponsibleRole = (role: unknown): boolean =>
  typeof role === 'string' &&
  MARKET_RESPONSIBLE_ROLES.includes(role.trim().toLowerCase() as Roles);

/** Xato javobidagi mashina kodlari (`PUBLIC_ERROR_CODES` ga ham qo'shilgan). */
export const CONTACT_ERROR_CODES = {
  SUPPORT_PHONES_INVALID: 'SUPPORT_PHONES_INVALID',
  RESPONSIBLE_ROLE_INVALID: 'RESPONSIBLE_ROLE_INVALID',
  RESPONSIBLE_INACTIVE: 'RESPONSIBLE_INACTIVE',
  NOT_A_MARKET: 'NOT_A_MARKET',
} as const;

/** Jurnal fe'llari (`action-registry.ts` da ham). */
export const CONTACT_AUDIT_ACTIONS = {
  RESPONSIBLE_ASSIGNED: 'market.responsible_assigned',
  SETTINGS_UPDATED: 'settings.contacts_updated',
} as const;

/** RMQ naqshlari (identity-service). */
export const CONTACT_PATTERNS = {
  SETTINGS_GET: 'identity.contacts.settings.get',
  SETTINGS_UPDATE: 'identity.contacts.settings.update',
  RESPONSIBLES_LIST: 'identity.contacts.responsibles.list',
  RESPONSIBLE_BULK: 'identity.contacts.responsible.bulk',
  RESPONSIBLE_SET: 'identity.contacts.responsible.set',
  MY_CONTACTS: 'identity.contacts.for_user',
  PROBLEM_CONTACTS: 'identity.contacts.problem',
} as const;

export type ResponsibleSource = 'assigned' | 'default' | 'none';

/** Mas'ul xulosasi (`GET /markets`, `GET /users/:id` — market). */
export interface ResponsibleSummary {
  id: string;
  name: string;
  phone_number: string;
  role: string;
}

/** «Muammo bo'lsa» qatori — buyurtma javoblarida `problem_contacts`. */
export interface ProblemContact {
  name: string | null;
  phone: string;
  source: 'logist' | 'support';
}

/** `GET /users/me/contacts` javobi. */
export interface MyContacts {
  kind: 'market_responsible' | 'region_logist' | 'none';
  source: 'assigned' | 'default' | 'support' | null;
  regions: Array<{ id: string; name: string }>;
  contacts: Array<{
    user_id: string | null;
    name: string | null;
    phone: string;
    role: string | null;
  }>;
}

/**
 * Zaxira raqamlarni tekshiradi va normallaydi: har biri `+998XXXXXXXXX`,
 * takrorsiz (normallangandan keyin), ko'pi bilan `SUPPORT_PHONES_MAX`.
 * Massiv emas, satr bo'lmagan element, tanilmagan raqam, takror yoki
 * chegaradan ko'p — `null` (chaqiruvchi 400 `SUPPORT_PHONES_INVALID` beradi).
 */
export function normalizeSupportPhones(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SUPPORT_PHONES_MAX) {
    return null;
  }
  const phones: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      return null;
    }
    const phone = normalizeUzPhone(raw);
    if (!phone || phones.includes(phone)) {
      return null;
    }
    phones.push(phone);
  }
  return phones;
}

/**
 * Saqlangan qiymatdan zaxira raqamlar (o'qishda — qat'iy emas): yaroqsiz
 * elementlar tashlanadi, takrorsiz, ko'pi bilan `SUPPORT_PHONES_MAX`.
 */
export function readSupportPhones(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const phones: string[] = [];
  for (const raw of value) {
    const phone = typeof raw === 'string' ? normalizeUzPhone(raw) : null;
    if (phone && !phones.includes(phone)) {
      phones.push(phone);
    }
  }
  return phones.slice(0, SUPPORT_PHONES_MAX);
}

/**
 * Chek/yorliq ko'rinishi (ega, 2026-10-29): `+998901112233` →
 * `+998 90 111 22 33`. Tanilmagan qiymat — o'zgarishsiz (trim).
 */
export function formatContactPhone(phone: unknown): string {
  const text =
    typeof phone === 'string' || typeof phone === 'number'
      ? String(phone).trim()
      : '';
  const normalized = normalizeUzPhone(text);
  if (!normalized) {
    return text;
  }
  const n = normalized.slice(4);
  return `+998 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
}

/**
 * `problem_contacts` ni tozalaydi: telefoni bor elementlar, telefon bo'yicha
 * takrorsiz, ko'pi bilan `PROBLEM_CONTACTS_MAX`.
 */
export function dedupeProblemContacts(
  contacts: readonly ProblemContact[],
): ProblemContact[] {
  const seen = new Set<string>();
  const result: ProblemContact[] = [];
  for (const contact of contacts) {
    const phone = String(contact?.phone ?? '').trim();
    const key = normalizeUzPhone(phone) ?? phone;
    if (!phone || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...contact, phone });
  }
  return result.slice(0, PROBLEM_CONTACTS_MAX);
}
