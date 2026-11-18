import {
  AI_MAX_CANDIDATES,
  escapeTelegramHtml,
  normalizeUzPhone,
} from '@app/common';
import {
  activeChecks,
  type AiDistrictOption,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * Botdagi «✏️ Tuzatish»: ai-confirm DTO allaqachon qabul qiladigan
 * maydonlar — mijoz ismi, telefon, manzil, izoh, mahsulot soni — va tuman
 * (nomzodlar / viloyat tumanlari). Maydon tanlanadi → yangi qiymat matn
 * bilan → tekshiriladi → karta qayta chiziladi. Tugma payload'ida faqat
 * indekslar va maydon kaliti; qiymatlar qoralamada (`telegram_ai_drafts`).
 */

/** Matn bilan tuzatiladigan maydonlar (payload `f`). */
export const AI_EDIT_FIELDS = [
  'name',
  'phone',
  'address',
  'comment',
  'qty',
] as const;
export type AiEditField = (typeof AI_EDIT_FIELDS)[number];

export const isEditField = (value: unknown): value is AiEditField =>
  typeof value === 'string' &&
  (AI_EDIT_FIELDS as readonly string[]).includes(value);

/** Tuman tanlash ro'yxati manbai: `c` — AI nomzodlari, `r` — viloyat tumanlari. */
export type AiDistrictSource = 'c' | 'r';

/** Viloyat tumanlari ro'yxatida ko'pi bilan shuncha tugma. */
export const AI_DISTRICT_MAX_OPTIONS = 40;
/** Kartadagi «📍 Tumanni tanlash» tugmalari soni. */
export const AI_DISTRICT_MAX_ENTRIES = 5;
/** Tuzatish menyusida «🔢 Soni» tugmalari soni. */
export const AI_EDIT_MAX_ITEMS = 5;

const NAME_MIN = 2;
const NAME_MAX = 120;
const ADDRESS_MIN = 3;
const ADDRESS_MAX = 255;
const COMMENT_MAX = 1000;
const QTY_MAX = 999;

export const AI_EDIT_PROMPTS: Record<AiEditField, string> = {
  name: '👤 Mijozning ismini yozib yuboring.',
  phone: '📞 Mijoz telefonini yozib yuboring (masalan: 90 123 45 67).',
  address: '🏠 Manzilni yozib yuboring («-» — manzilni o‘chirish).',
  comment: '💬 Izohni yozib yuboring («-» — izohni o‘chirish).',
  qty: `🔢 Mahsulot sonini yozib yuboring (1–${QTY_MAX}).`,
};

export const AI_EDIT_ERRORS: Record<AiEditField, string> = {
  name: `✏️ Ism ${NAME_MIN}–${NAME_MAX} belgi va harf bilan bo‘lsin — qayta yozing.`,
  phone:
    '📞 Telefon noto‘g‘ri — O‘zbekiston raqamini yozing (masalan: 90 123 45 67).',
  address: `🏠 Manzil ${ADDRESS_MIN}–${ADDRESS_MAX} belgi bo‘lsin — qayta yozing.`,
  comment: `💬 Izoh ${COMMENT_MAX} belgidan oshmasin — qayta yozing.`,
  qty: `🔢 Son 1 dan ${QTY_MAX} gacha butun son bo‘lsin — qayta yozing.`,
};

export const AI_EDIT_NO_DISTRICT_TEXT =
  '📍 Viloyat aniqlanmadi — tumanni botda tanlab bo‘lmaydi. Matnga viloyatni qo‘shib qayta yuboring yoki kabinetda yarating.';
export const AI_DISTRICT_LOAD_FAILED_TEXT =
  '❌ Tumanlar ro‘yxatini olib bo‘lmadi — birozdan so‘ng qayta urinib ko‘ring.';

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const html = (value: unknown, max = 120) =>
  escapeTelegramHtml(clip(value, max));

/**
 * Operator yozgan qiymatni tekshiradi. `ok: false` — xato matni (kutish
 * davom etadi). Telefon — repo'ning `normalizeUzPhone` (`+998XXXXXXXXX`).
 * Manzil / izoh: «-» — o'chirish (`null`).
 */
export function parseEditValue(
  field: AiEditField,
  input: string,
): { ok: true; value: string | number | null } | { ok: false; error: string } {
  const text = input.replace(/\s+/g, ' ').trim();
  const fail = { ok: false as const, error: AI_EDIT_ERRORS[field] };
  switch (field) {
    case 'name':
      return text.length >= NAME_MIN &&
        text.length <= NAME_MAX &&
        /\p{L}/u.test(text)
        ? { ok: true, value: text }
        : fail;
    case 'phone': {
      const phone = normalizeUzPhone(text);
      return phone ? { ok: true, value: phone } : fail;
    }
    case 'address':
      if (text === '-') return { ok: true, value: null };
      return text.length >= ADDRESS_MIN && text.length <= ADDRESS_MAX
        ? { ok: true, value: text }
        : fail;
    case 'comment':
      if (text === '-') return { ok: true, value: null };
      return text.length >= 1 && text.length <= COMMENT_MAX
        ? { ok: true, value: text }
        : fail;
    case 'qty': {
      if (!/^\d{1,3}$/.test(text)) return fail;
      const qty = Number(text);
      return qty >= 1 && qty <= QTY_MAX ? { ok: true, value: qty } : fail;
    }
  }
}

/** Maydon qiymatini kutish muddati (qidiruvdan qisqa). */
export const AI_EDIT_INPUT_TTL_MS = 5 * 60_000;

/**
 * Matnda O'zbekiston telefon raqami bormi: raqam guruhlarining har
 * ketma-ket bo'lagi repo'ning `normalizeUzPhone` bilan tekshiriladi
 * («Chilonzor 5 90 111 22 33» — «5» qo'shilib ketmaydi).
 */
export function containsUzPhone(text: string): boolean {
  for (const run of text.match(/\+?\d[\d\s\-()]*\d/g) ?? []) {
    const groups = run.match(/\d+/g) ?? [];
    for (let a = 0; a < groups.length; a += 1) {
      let digits = '';
      for (let b = a; b < groups.length; b += 1) {
        digits += groups[b];
        if (digits.length > 12) break;
        if (digits.length >= 9 && normalizeUzPhone(digits)) return true;
      }
    }
  }
  return false;
}

/**
 * Maydon qiymati kutilayotganda yangi buyurtma matni kelganmi (kutish
 * tugaydi, matn AI ga ketadi):
 *  - manzil / izoh: ko'p qatorli yoki ichida telefon raqami;
 *  - telefon: harf VA 7+ raqam yoki 40 belgidan uzun;
 *  - ism / soni: ko'p qatorli yoki 7+ raqam.
 */
export function endsEditInput(field: AiEditField, text: string): boolean {
  const trimmed = text.trim();
  const multiline = /\n/.test(trimmed);
  const digits = (trimmed.match(/\d/g) ?? []).length;
  switch (field) {
    case 'address':
    case 'comment':
      return multiline || containsUzPhone(trimmed);
    case 'phone':
      return (
        multiline ||
        trimmed.length > 40 ||
        (/\p{L}/u.test(trimmed) && digits >= 7)
      );
    case 'name':
    case 'qty':
      return multiline || digits >= 7;
  }
}

const withoutIssues = (order: AiPreviewOrder, drop: string[]) =>
  Array.isArray(order.issues)
    ? order.issues.filter((issue) => !drop.includes(issue))
    : order.issues;

/**
 * Tekshirilgan qiymatni buyurtmaga yozadi (yangi massiv). Tegishli
 * kamchilik (`name_missing` / `phone_invalid`) va eski qiymatga oid yumshoq
 * tekshiruv (`phone_is_market`, `same_phone_multi`, shu item `qty_check`)
 * olib tashlanadi. Buyurtma / item topilmasa — null.
 */
export function applyFieldEdit(
  orders: AiPreviewOrder[],
  orderIndex: number,
  field: AiEditField,
  itemIndex: number,
  value: string | number | null,
): AiPreviewOrder[] | null {
  const order = orders.find((o) => o.index === orderIndex);
  if (!order) return null;
  if (field === 'qty' && !order.items?.[itemIndex]) return null;
  return orders.map((o) => {
    const checks = Array.isArray(o.checks) ? o.checks : [];
    if (o.index !== orderIndex) {
      // Telefon o'zgardi — boshqa buyurtmadagi «shu telefon N-buyurtmada
      // ham bor» ogohlantirishi (N = tahrirlangan) endi eskirgan.
      return field === 'phone' &&
        checks.some(
          (c) =>
            c?.code === 'same_phone_multi' && c?.other_index === orderIndex,
        )
        ? {
            ...o,
            checks: checks.filter(
              (c) =>
                !(
                  c?.code === 'same_phone_multi' &&
                  c?.other_index === orderIndex
                ),
            ),
          }
        : o;
    }
    switch (field) {
      case 'name':
        return {
          ...o,
          customer_name: String(value),
          issues: withoutIssues(o, ['name_missing']),
        };
      case 'phone':
        return {
          ...o,
          phone_number: String(value),
          issues: withoutIssues(o, ['phone_invalid']),
          checks: checks.filter(
            (c) =>
              c?.code !== 'phone_is_market' && c?.code !== 'same_phone_multi',
          ),
        };
      case 'address':
        return { ...o, address: value === null ? null : String(value) };
      case 'comment':
        return { ...o, comment: value === null ? null : String(value) };
      case 'qty':
        return {
          ...o,
          items: (o.items ?? []).map((item, i) =>
            i === itemIndex ? { ...item, quantity: Number(value) } : item,
          ),
          checks: checks.filter(
            (c) => !(c?.code === 'qty_check' && c?.item_index === itemIndex),
          ),
        };
    }
  });
}

/** Tuman id'si (raqam) — confirm `district_id` qoidasi. */
const districtId = (value: unknown): string | null => {
  const id = clip(value, 20);
  return /^\d{1,20}$/.test(id) ? id : null;
};

/** AI nomzodlari (`label` = "<viloyat>, <tuman>") → tanlanadigan tumanlar. */
export function districtCandidates(order: AiPreviewOrder): AiDistrictOption[] {
  const raw = Array.isArray(order.district_candidates)
    ? order.district_candidates
    : [];
  const out: AiDistrictOption[] = [];
  for (const c of raw) {
    const id = districtId(c?.id);
    const label = clip(c?.label, 120);
    if (!id || !label || out.some((o) => o.id === id)) continue;
    const name = label.includes(', ')
      ? label.slice(label.lastIndexOf(', ') + 2)
      : label;
    out.push({ id, name, region_name: clip(c?.region_name, 60) || null });
    if (out.length >= AI_MAX_CANDIDATES) break;
  }
  return out;
}

/** Saqlangan viloyat tumanlari (bot ichki `district_options`). */
export function storedDistrictOptions(
  order: AiPreviewOrder,
): AiDistrictOption[] {
  return districtOptionsOf(order.district_options);
}

/** `{ id, name }` ro'yxati — faqat to'g'ri shakldagilar, nom bo'yicha. */
export function districtOptionsOf(
  value: unknown,
  max: number = AI_DISTRICT_MAX_OPTIONS,
): AiDistrictOption[] {
  if (!Array.isArray(value)) return [];
  const out: AiDistrictOption[] = [];
  for (const raw of value) {
    const entry = raw as {
      id?: unknown;
      name?: unknown;
      region_name?: unknown;
    } | null;
    const id = districtId(entry?.id);
    const name = clip(entry?.name, 60);
    if (!id || !name || out.some((o) => o.id === id)) continue;
    out.push({
      id,
      name,
      region_name: clip(entry?.region_name, 60) || null,
    });
  }
  return out.slice(0, max);
}

/** `GET /district?region_id=` javobi (`successRes` — `data` massivi) → tumanlar. */
export function districtsFromResponse(
  body: unknown,
  regionName: string | null,
): { options: AiDistrictOption[]; total: number } {
  const data = (body as { data?: unknown } | null)?.data;
  const list = Array.isArray(data) ? data : [];
  const all = districtOptionsOf(
    list
      .map((d: { id?: unknown; name?: unknown }) => ({
        id: d?.id,
        name: d?.name,
        region_name: regionName,
      }))
      .sort((a, b) => clip(a.name, 60).localeCompare(clip(b.name, 60))),
    Number.POSITIVE_INFINITY,
  );
  return { options: all.slice(0, AI_DISTRICT_MAX_OPTIONS), total: all.length };
}

/** Tuman kerakmi: id yo'q yoki AI ikkilangan (tahrirdan keyin — yo'q). */
export function needsDistrict(order: AiPreviewOrder): boolean {
  return (
    !districtId(order.district_id) ||
    activeChecks(order).some((c) => c?.code === 'district_low_confidence')
  );
}

/** Botda tuman tanlab bo'ladimi (nomzod yoki viloyat bor). */
export const canPickDistrict = (order: AiPreviewOrder): boolean =>
  districtCandidates(order).length > 0 || Boolean(districtId(order.region_id));

/**
 * Tuman tanlandi: `district_id` + ko'rsatish nomlari; birinchi tahrirda
 * AI taklifi `ai_district_id` ga saqlanadi (ack qoidasi uchun).
 * `district_missing` / `region_missing` olib tashlanadi.
 */
export function applyDistrictPick(
  orders: AiPreviewOrder[],
  orderIndex: number,
  option: AiDistrictOption,
): AiPreviewOrder[] {
  return orders.map((o) => {
    if (o.index !== orderIndex) return o;
    return {
      ...o,
      ai_district_id:
        o.ai_district_id !== undefined
          ? o.ai_district_id
          : districtId(o.district_id),
      district_id: option.id,
      district_name: option.name,
      ...(option.region_name ? { region_name: option.region_name } : {}),
      issues: withoutIssues(o, ['district_missing', 'region_missing']),
    };
  });
}

/** «✏️ Tuzatish» menyusining matni (HTML) — joriy qiymatlar bilan. */
export function editMenuText(order: AiPreviewOrder): string {
  const items = (order.items ?? [])
    .slice(0, 8)
    .map(
      (item) =>
        `${html(item.resolved_name || item.name, 60)} ×${Math.max(1, Math.trunc(Number(item.quantity ?? 1)))}`,
    )
    .join('; ');
  const place = [order.region_name, order.district_name]
    .map((part) => clip(part, 60))
    .filter(Boolean)
    .join(', ');
  return [
    `✏️ <b>${order.index + 1}-buyurtma</b> — nimani tuzatamiz?`,
    '',
    `👤 ${html(order.customer_name) || '—'}`,
    `📞 ${html(order.phone_number, 40) || '—'}`,
    `📍 ${escapeTelegramHtml(place || '—')}`,
    `🏠 ${html(order.address) || '—'}`,
    `📦 ${items || '—'}`,
    `💬 ${html(order.comment, 200) || '—'}`,
  ].join('\n');
}

/** Tuman tanlash oynasining matni (HTML). */
export function districtPickerText(
  order: AiPreviewOrder,
  source: AiDistrictSource,
): string {
  const current = clip(order.district_name, 60);
  // Ro'yxat chegarasidan (40) ortiq tumanlar — jim kesilmaydi.
  const hidden =
    source === 'r'
      ? Math.trunc(Number(order.district_options_total) || 0) -
        storedDistrictOptions(order).length
      : 0;
  return [
    `📍 <b>${order.index + 1}-buyurtma</b> — tumanni tanlang.`,
    current ? `Hozir: ${escapeTelegramHtml(current)}` : 'Hozir: —',
    source === 'c'
      ? 'AI taklif qilgan tumanlar:'
      : `${escapeTelegramHtml(clip(order.region_name, 60) || 'Viloyat')} tumanlari:`,
    ...(hidden > 0
      ? [`… yana ${hidden} ta — kerakli tuman bo‘lmasa kabinetda yarating.`]
      : []),
  ].join('\n');
}

/** Qiymat kiritish so'rovi (qty — item nomi bilan). */
export function editPromptText(
  order: AiPreviewOrder,
  field: AiEditField,
  itemIndex: number,
): string {
  const head = `✏️ <b>${order.index + 1}-buyurtma</b>`;
  if (field === 'qty') {
    const item = order.items?.[itemIndex];
    return `${head}: «${html(item?.resolved_name || item?.name, 60) || 'Mahsulot'}»\n${escapeTelegramHtml(AI_EDIT_PROMPTS.qty)}\nBekor qilish — «↩️ Orqaga».`;
  }
  return `${head}\n${escapeTelegramHtml(AI_EDIT_PROMPTS[field])}\nBekor qilish — «↩️ Orqaga».`;
}
