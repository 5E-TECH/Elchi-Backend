import { BadRequestException } from '@nestjs/common';
import { Cashbox_type, PaymentMethod } from '@app/common';

/**
 * KRN902pg — kassa tarixining «To'lov usuli» va «Karta» filtrlari (BeePost
 * `cashboxFilters.tsx` dagidek). `GET /finance/history`, `GET
 * /finance/history/daily` va `GET /finance/cashbox/user/:id` (tarix) — BITTA
 * ma'no, shu modul orqali.
 *
 *  • `payment_method` — vergul bilan bir nechta: `cash`, `click`,
 *    `click_to_market`, `none` (usuli bo'sh qator). Qiymatlar o'zaro OR,
 *    boshqa filtrlar bilan AND. Noma'lum qiymat → 400.
 *  • `card_id` — vergul bilan bir nechta karta ID si va/yoki `none`. Qator
 *    kartasi — tarix tafsilotidagi `card` bilan AYNI qoida (faqat ASOSIY
 *    kassa qatorida karta bo'ladi):
 *      – `card_id` yozilgan — o'sha karta;
 *      – `card_id` bo'sh, usul `click` — kassaning Asosiy kartasi (Asosiy
 *        karta to'lovi `card_id` siz yoziladi), shuning uchun Asosiy karta
 *        ID si tanlansa bu qatorlar ham chiqadi;
 *      – KURYER / MARKET kassasi qatori — o'sha o'tkazmaning (`transfer_id`)
 *        asosiy kassa qatoridagi karta (kuryer HQ kartasiga topshirgan pul,
 *        HQ market'ga kartadan to'lagan pul); shunday qilib kuryer / market
 *        kassasi sahifasida ham «Karta» filtri ishlaydi;
 *      – qolgani (naqd, «Marketga o'tkazma», filial kassasi — 63HO6cBU:
 *        filialda karta yo'q) — kartasiz: `none`.
 *    Raqam yoki `none` bo'lmagan qiymat → 400.
 *
 * 63HO6cBU: kuryer filial oyog'i qatorida usul va kartani ko'rmaydi — filtr
 * orqali ham bilib olmasin: gateway bu filtrlarni faqat usulni to'liq
 * ko'radigan rollarga (SA/admin, menejer, registrator) ochadi.
 */
export const HISTORY_FILTER_NONE = 'none';

export const HISTORY_PAYMENT_METHOD_FILTER_VALUES: readonly string[] = [
  PaymentMethod.CASH,
  PaymentMethod.CLICK,
  PaymentMethod.CLICK_TO_MARKET,
  HISTORY_FILTER_NONE,
];

const METHOD_VALUES = new Set(HISTORY_PAYMENT_METHOD_FILTER_VALUES);
/** bigint chegarasidan oshmaydigan ID (aks holda Postgres 500 berardi). */
const CARD_ID = /^\d{1,18}$/;

export interface HistoryMethodCardInput {
  payment_method?: unknown;
  card_id?: unknown;
}

export interface HistoryMethodCardFilter {
  /** Tanlangan usullar (`none` siz) va `none` belgisi. */
  method?: { values: string[]; none: boolean };
  /** Tanlangan karta ID'lari, `none` va ulardan qaysilari Asosiy karta. */
  card?: { ids: string[]; none: boolean; defaultCashboxIds: string[] };
}

export interface HistoryFilterTables {
  /** `cashbox_history` (sxema bilan, qo'shtirnoqda). */
  history: string;
  /** `cashboxes` (sxema bilan, qo'shtirnoqda). */
  cashboxes: string;
}

/** SQL parametr bog'lovchisi: qiymatni qo'shib, joy belgisini qaytaradi. */
export type SqlBind = (value: unknown, cast?: string) => string;

const shown = (value: string) =>
  value.length > 40 ? `${value.slice(0, 40)}…` : value;

function splitValues(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts: unknown[] = Array.isArray(raw) ? raw : [raw];
  const values: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string' && typeof part !== 'number') {
      throw new BadRequestException(`${field} noto'g'ri`);
    }
    for (const piece of String(part).split(',')) {
      const value = piece.trim().toLowerCase();
      if (value) values.push(value);
    }
  }
  return values.length ? Array.from(new Set(values)) : undefined;
}

/** Faqat tekshiradi (400) — DB'ga tegmaydi. Filtr yo'q bo'lsa `null`. */
export function parseHistoryMethodCardFilter(
  input: HistoryMethodCardInput | undefined,
): { methods?: string[]; cards?: string[] } | null {
  const methods = splitValues(input?.payment_method, 'payment_method');
  for (const value of methods ?? []) {
    if (!METHOD_VALUES.has(value)) {
      throw new BadRequestException(
        `payment_method noto'g'ri: ${shown(value)} (cash, click, click_to_market yoki none)`,
      );
    }
  }
  const cards = splitValues(input?.card_id, 'card_id');
  for (const value of cards ?? []) {
    if (value !== HISTORY_FILTER_NONE && !CARD_ID.test(value)) {
      throw new BadRequestException(
        `card_id noto'g'ri: ${shown(value)} (karta ID si yoki none)`,
      );
    }
  }
  if (!methods && !cards) return null;
  return { methods, cards };
}

/**
 * Tekshiradi va Asosiy kartalarni aniqlaydi. `defaultCardsAmong` —
 * berilgan ID'lardan Asosiy (`is_default`) bo'lganlari va ularning kassasi.
 */
export async function resolveHistoryMethodCardFilter(
  input: HistoryMethodCardInput | undefined,
  defaultCardsAmong: (
    ids: string[],
  ) => Promise<Array<{ id: string; cashbox_id: string }>>,
): Promise<HistoryMethodCardFilter | null> {
  const parsed = parseHistoryMethodCardFilter(input);
  if (!parsed) return null;
  const filter: HistoryMethodCardFilter = {};
  if (parsed.methods) {
    filter.method = {
      values: parsed.methods.filter((value) => value !== HISTORY_FILTER_NONE),
      none: parsed.methods.includes(HISTORY_FILTER_NONE),
    };
  }
  if (parsed.cards) {
    const ids = parsed.cards.filter((value) => value !== HISTORY_FILTER_NONE);
    const defaults = ids.length ? await defaultCardsAmong(ids) : [];
    filter.card = {
      ids,
      none: parsed.cards.includes(HISTORY_FILTER_NONE),
      defaultCashboxIds: Array.from(
        new Set(defaults.map((card) => String(card.cashbox_id))),
      ),
    };
  }
  return filter;
}

/**
 * `h` qatoriga (alias) filtr sharti — bo'laklar AND bilan. Filtr bo'sh
 * bo'lsa `TRUE`.
 */
export function historyMethodCardSql(
  h: string,
  filter: HistoryMethodCardFilter,
  tables: HistoryFilterTables,
  bind: SqlBind,
): string {
  const parts: string[] = [];
  if (filter.method) {
    const options: string[] = [];
    if (filter.method.values.length) {
      options.push(
        `${h}."payment_method"::text = ANY(${bind(filter.method.values, 'text[]')})`,
      );
    }
    if (filter.method.none) options.push(`${h}."payment_method" IS NULL`);
    parts.push(`(${options.join(' OR ')})`);
  }
  if (filter.card) {
    parts.push(cardSql(h, filter.card, tables, bind));
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

function cardSql(
  h: string,
  card: NonNullable<HistoryMethodCardFilter['card']>,
  tables: HistoryFilterTables,
  bind: SqlBind,
): string {
  const ofType = (alias: string, types: Cashbox_type[]) =>
    `${alias}."cashbox_id" IN (SELECT cb."id" FROM ${tables.cashboxes} cb WHERE cb."cashbox_type"::text IN (${types
      .map((type) => `'${type}'`)
      .join(', ')}))`;
  const inMain = (alias: string) => ofType(alias, [Cashbox_type.MAIN]);
  /** Qator o'zi (asosiy kassa qatori sifatida) tanlangan kartaga tegishli. */
  const ownMatch = (alias: string): string | null => {
    const options: string[] = [];
    if (card.ids.length) {
      options.push(`${alias}."card_id" = ANY(${bind(card.ids, 'bigint[]')})`);
    }
    if (card.defaultCashboxIds.length) {
      options.push(
        `(${alias}."card_id" IS NULL AND ${alias}."payment_method"::text = '${PaymentMethod.CLICK}'` +
          ` AND ${alias}."cashbox_id" = ANY(${bind(card.defaultCashboxIds, 'bigint[]')}))`,
      );
    }
    return options.length
      ? `(${inMain(alias)} AND (${options.join(' OR ')}))`
      : null;
  };
  /** Qatorda (asosiy kassa qatori sifatida) biror karta bor. */
  const ownHasCard = (alias: string) =>
    `(${inMain(alias)} AND (${alias}."card_id" IS NOT NULL OR ${alias}."payment_method"::text = '${PaymentMethod.CLICK}'))`;
  /** Kuryer / market qatori — o'tkazmaning asosiy kassa qatori sharti. */
  const viaTransfer = (condition: string) =>
    `(${h}."transfer_id" IS NOT NULL AND ${ofType(h, [
      Cashbox_type.FOR_COURIER,
      Cashbox_type.FOR_MARKET,
    ])} AND EXISTS (SELECT 1 FROM ${tables.history} m WHERE m."transfer_id" = ${h}."transfer_id"` +
    ` AND m."id" <> ${h}."id" AND m."is_deleted" = false AND ${condition}))`;

  const options: string[] = [];
  const selected = ownMatch(h);
  if (selected) {
    options.push(selected, viaTransfer(ownMatch('m') as string));
  }
  if (card.none) {
    options.push(
      `NOT COALESCE((${ownHasCard(h)} OR ${viaTransfer(ownHasCard('m'))}), false)`,
    );
  }
  return `(${options.join(' OR ')})`;
}

/** TypeORM `Raw(..., params)` uchun nomli parametrlar. */
export function namedSqlBinder(prefix: string): {
  bind: SqlBind;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  let index = 0;
  const bind: SqlBind = (value, cast) => {
    const key = `${prefix}${index++}`;
    params[key] = value;
    return cast ? `CAST(:${key} AS ${cast})` : `:${key}`;
  };
  return { bind, params };
}

/** `dataSource.query(sql, params)` uchun `$n` parametrlar. */
export function positionalSqlBinder(params: unknown[]): SqlBind {
  return (value, cast) => {
    params.push(value);
    return cast ? `$${params.length}::${cast}` : `$${params.length}`;
  };
}

/** Jadval yo'li → SQL (`"schema"."table"`). */
export function quoteTablePath(tablePath: string): string {
  return tablePath
    .split('.')
    .map((part) => `"${part.replace(/"/g, '')}"`)
    .join('.');
}
