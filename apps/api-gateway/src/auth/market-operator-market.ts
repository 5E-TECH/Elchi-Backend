import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

/** identity `user.find_by_id` — gateway'dagi boshqa identity o'qishlari bilan bir xil 8 s. */
export const MARKET_OPERATOR_PROFILE_TIMEOUT_MS = 8000;

/**
 * Bitta operator — bir nechta market (ega qarorlari 2026-11-28, D1–D8),
 * 2-bosqich: market operatorining DOIRASI — u faol ishlaydigan marketlar.
 *
 * YAGONA MANBA: identity `user.find_by_id` javobidagi `operator_markets`
 * (a'zoliklar, `identity_schema.market_operator_markets`, asosiy birinchi).
 * So'rovdagi `market_id` ga hech qachon ishonilmaydi — u faqat doira
 * ICHIDAN tanlov (`pickOperatorMarket`). Ilgari gateway'da bu hisob 7 joyda
 * alohida (`user.market_id`) yozilgan edi.
 *
 * O'tish davri: identity `operator_markets` bermasa (a'zolik servisi yo'q /
 * o'qish xatosi / eski identity) — avvalgidek `market_id` (u asosiy a'zolik
 * bilan trigger orqali bir xil, migratsiya 255). `operator_markets` BOR,
 * lekin bo'sh — faol market yo'q (marketga qaytilmaydi).
 */
export interface OperatorMarketScope {
  /** Faol a'zolik marketlari — asosiy birinchi, takrorsiz, kanonik id. */
  active: string[];
  /** Market → «Ombordagi qoldiq» kaliti (har market o'zi yoqadi). */
  warehouseStock: ReadonlyMap<string, boolean>;
}

export const EMPTY_OPERATOR_MARKET_SCOPE: OperatorMarketScope = Object.freeze({
  active: [],
  warehouseStock: new Map<string, boolean>(),
});

/** So'ralgan market operatorning faol marketlari qatorida emas. */
export const OPERATOR_MARKET_FOREIGN_MESSAGE =
  'Siz bu marketda operator emassiz';

/** 2+ faol marketli operator market tanlamadi (javob matni hamma joyda bir xil). */
export const OPERATOR_MARKET_AMBIGUOUS_MESSAGE =
  'Siz bir nechta marketda ishlaysiz — marketni tanlang (market_id)';

const ID_RE = /^\d{1,19}$/;

/** Kanonik market id ('007' → '7'); id emas yoki bo'sh — ''. */
export function canonicalMarketId(value: unknown): string {
  const raw =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return ID_RE.test(raw) ? BigInt(raw).toString() : '';
}

/**
 * identity `user.find_by_id` javobi (`{ data }` yoki o'ramsiz) → doira.
 * Faqat `status = 'active'` a'zoliklar; `pending` (taklif) va `inactive`
 * doiraga kirmaydi.
 */
export function operatorMarketScopeFromProfile(
  profile: unknown,
): OperatorMarketScope {
  const source = profile as { data?: unknown } | null;
  const data = (
    source && typeof source === 'object' && 'data' in source
      ? source.data
      : source
  ) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') {
    return EMPTY_OPERATOR_MARKET_SCOPE;
  }

  const active: string[] = [];
  const warehouseStock = new Map<string, boolean>();
  const memberships = data.operator_markets;
  if (Array.isArray(memberships)) {
    for (const raw of memberships) {
      const item = raw as {
        market_id?: unknown;
        status?: unknown;
        can_view_warehouse_stock?: unknown;
      } | null;
      const marketId = canonicalMarketId(item?.market_id);
      if (!marketId || item?.status !== 'active') continue;
      if (warehouseStock.has(marketId)) continue;
      active.push(marketId);
      warehouseStock.set(marketId, item?.can_view_warehouse_stock === true);
    }
    return { active, warehouseStock };
  }

  // O'tish davri: a'zoliklar berilmagan — yagona `market_id`.
  const legacy = canonicalMarketId(data.market_id);
  if (legacy) {
    active.push(legacy);
    warehouseStock.set(legacy, data.can_view_warehouse_stock === true);
  }
  return { active, warehouseStock };
}

/**
 * Market tomoni: operator SHU marketning operatorimi (faol yoki market
 * nofaol qilgan — `active` / `inactive` a'zolik; taklif `pending` va
 * chiqarilgan hisobga olinmaydi). `profile` — identity `user.find_by_id`
 * (`{ data }` yoki o'ramsiz). O'tish davri: `operator_markets` yo'q — `market_id`.
 */
export function operatorBelongsToMarket(
  profile: unknown,
  marketId: unknown,
): boolean {
  const wanted = canonicalMarketId(marketId);
  if (!wanted) return false;
  const source = profile as { data?: unknown } | null;
  const data = (
    source && typeof source === 'object' && 'data' in source
      ? source.data
      : source
  ) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data.operator_markets)) {
    return data.operator_markets.some((raw) => {
      const item = raw as { market_id?: unknown; status?: unknown } | null;
      return (
        canonicalMarketId(item?.market_id) === wanted &&
        (item?.status === 'active' || item?.status === 'inactive')
      );
    });
  }
  return canonicalMarketId(data.market_id) === wanted;
}

/**
 * Market operatorining profili (identity `user.find_by_id` `data`).
 * Identity javob bermasa — null (chaqiruvchi rad etadi, fail-closed).
 */
export async function loadMarketOperatorProfile(
  identityClient: Pick<ClientProxy, 'send'>,
  userId: unknown,
): Promise<Record<string, unknown> | null> {
  const profile: unknown = await firstValueFrom(
    identityClient
      .send({ cmd: 'identity.user.find_by_id' }, { id: userId })
      .pipe(timeout(MARKET_OPERATOR_PROFILE_TIMEOUT_MS)),
  ).catch(() => null);
  const data = (profile as { data?: unknown } | null)?.data;
  return data && typeof data === 'object'
    ? (data as Record<string, unknown>)
    : null;
}

/** Operator doirasi; identity javob bermasa — bo'sh (fail-closed). */
export async function resolveOperatorMarketScope(
  identityClient: Pick<ClientProxy, 'send'>,
  userId: unknown,
): Promise<OperatorMarketScope> {
  return operatorMarketScopeFromProfile(
    await loadMarketOperatorProfile(identityClient, userId),
  );
}

/** Market operatorning faol doirasidami. */
export function isOperatorMarket(
  scope: OperatorMarketScope,
  marketId: unknown,
): boolean {
  const id = canonicalMarketId(marketId);
  return id !== '' && scope.active.includes(id);
}

export type OperatorMarketPick =
  | { ok: true; marketId: string }
  | {
      ok: false;
      /**
       * - unassigned — faol market yo'q;
       * - foreign — so'ralgan market doirada emas;
       * - ambiguous — 2+ faol market, tanlov berilmagan.
       */
      reason: 'unassigned' | 'foreign' | 'ambiguous';
    };

/**
 * Bitta amal uchun market (yozish yoki bitta marketli o'qish):
 *  - `requested` berilgan → doirada bo'lsa o'sha, aks holda `foreign`
 *    (faol market umuman yo'q bo'lsa `unassigned`);
 *  - berilmagan → yagona faol market; 0 — `unassigned`, 2+ — `ambiguous`.
 *
 * `ignoreRequestedWhenSingle` — HOZIR tanadagi `market_id` ni e'tiborsiz
 * qoldiradigan endpointlar uchun (buyurtma yaratish, AI, mijoz takliflari):
 * bitta faol marketda `requested` qaralmaydi (xatti-harakat o'zgarmaydi),
 * 2+ da u majburiy va doirada bo'lishi shart.
 */
export function pickOperatorMarket(
  scope: OperatorMarketScope,
  requested?: unknown,
  options: { ignoreRequestedWhenSingle?: boolean } = {},
): OperatorMarketPick {
  if (!scope.active.length) {
    return { ok: false, reason: 'unassigned' };
  }
  const raw =
    typeof requested === 'string' || typeof requested === 'number'
      ? String(requested).trim()
      : '';
  const single = scope.active.length === 1;
  if (raw && !(single && options.ignoreRequestedWhenSingle)) {
    const id = canonicalMarketId(raw);
    return id && scope.active.includes(id)
      ? { ok: true, marketId: id }
      : { ok: false, reason: 'foreign' };
  }
  return single
    ? { ok: true, marketId: scope.active[0] }
    : { ok: false, reason: 'ambiguous' };
}
