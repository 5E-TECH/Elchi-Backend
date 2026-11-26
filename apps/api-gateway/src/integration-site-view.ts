/**
 * «QABUL VA YARATISH» → «TASHQI SAYTLAR» — registrator uchun sayt ko'rinishi.
 *
 * `GET /integrations` va `GET /integrations/:id` superadmin/admin uchun to'liq ulanish sozlamasini beradi
 * (auth, dispatch, webhook, to'lov sozlamalari, `username`, maskalangan `credentials`). Registrator esa saytlar
 * tabida faqat sayt tanlaydi va posilka QR'ini skanerlaydi (`search-by-qr`, `orders/external/receive` unga
 * avvaldan ochiq) — unga ulanish sozlamasi kerak EMAS. Shu sabab registrator javobi OQ RO'YXAT:
 *  - faqat «sayt» ulanishlar — faol, marketi bor, to'lov tizimi emas (FE `isExternalSite` bilan bir xil);
 *  - faqat sayt ro'yxati va skan sahifasi o'qiydigan maydonlar;
 *  - manzillardan login/parol (`user:pass@`), query va `#` olib tashlanadi — QR qidiruvi uchun faqat yo'l kerak.
 */

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Satr yoki son → matn (bigint id'lar ikkala ko'rinishda keladi); boshqa tur — bo'sh. */
const textOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Ulanish to'liq sozlamasini ko'radigan rollar (gateway `@Roles` bilan bir xil). */
export const canSeeIntegrationConfig = (
  roles: readonly unknown[] | undefined,
): boolean =>
  (roles ?? []).some((role) => {
    const normalized = textOf(role).toLowerCase();
    return normalized === 'superadmin' || normalized === 'admin';
  });

/** Faol, marketi bor, to'lov tizimi emas — buyurtma shu marketdan yaratiladi (FE `isExternalSite`). */
export const isExternalSiteRow = (row: unknown): boolean =>
  isRecord(row) &&
  row.is_active === true &&
  textOf(row.market_id) !== '' &&
  textOf(row.role).toLowerCase() !== 'payment';

/** Manzil yoki yo'l — login/parol, query va `#` siz. */
export const safeSiteUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    // Nisbiy yo'l (`/api/qrorder/find`) — faqat yo'l qismi.
    return raw.split(/[?#]/)[0] || null;
  }
};

const marketView = (
  market: unknown,
): { id: string; name: string | null } | null => {
  const id = isRecord(market) ? textOf(market.id) : '';
  if (!isRecord(market) || !id) return null;
  return {
    id,
    name: typeof market.name === 'string' ? market.name : null,
  };
};

const externalSearchEndpoint = (config: unknown): string | null => {
  const search = isRecord(config) ? config.external_search : undefined;
  return isRecord(search) ? safeSiteUrl(search.endpoint) : null;
};

/** Bitta sayt — faqat ro'yxat va skan sahifasi o'qiydigan maydonlar. */
export const toSiteView = (row: Row): Row => {
  const endpoint = externalSearchEndpoint(row.status_sync_config);
  return {
    id: row.id,
    name: row.name ?? null,
    slug: row.slug ?? null,
    type: row.type ?? null,
    role: row.role ?? null,
    category: row.category ?? null,
    status: row.status ?? null,
    is_active: row.is_active === true,
    market_id: textOf(row.market_id) || null,
    market: marketView(row.market),
    base_url: safeSiteUrl(row.base_url),
    api_url: safeSiteUrl(row.api_url),
    field_mapping: isRecord(row.field_mapping) ? row.field_mapping : null,
    status_sync_config: endpoint ? { external_search: { endpoint } } : null,
    imported_orders: row.imported_orders ?? null,
    last_sync_at: row.last_sync_at ?? null,
  };
};

type ListResponse = { data?: unknown } & Row;

/**
 * `integration.find_all` javobi (sahifalangan: `{ items, market, markets, meta }`, sahifasiz: massiv) → faqat
 * saytlar, bitta sahifa. Market nomlari `markets` da — faqat ro'yxatdagi saytlarniki, `{ id, name }`.
 */
export const toSiteListResponse = (
  response: ListResponse | null | undefined,
): Row => {
  const data = response?.data;
  const rawItems: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : [];
  const items = rawItems
    .filter(isExternalSiteRow)
    .map((row) => toSiteView(row as Row));
  const marketIds = new Set(items.map((item) => String(item.market_id)));
  const rawMarkets: unknown[] =
    isRecord(data) && Array.isArray(data.markets) ? data.markets : [];
  const markets = rawMarkets
    .map(marketView)
    .filter((market): market is { id: string; name: string | null } =>
      Boolean(market && marketIds.has(market.id)),
    );
  return {
    ...(response ?? {}),
    data: {
      items,
      market: null,
      markets,
      meta: {
        page: 1,
        limit: items.length,
        total: items.length,
        totalPages: 1,
      },
    },
  };
};

/** `integration.find_by_id` javobi → sayt bo'lsa `toSiteView`, aks holda `null` (gateway 404 qaytaradi). */
export const toSiteDetailResponse = (
  response: ListResponse | null | undefined,
): Row | null => {
  const row = response?.data;
  if (!isExternalSiteRow(row)) return null;
  return { ...(response ?? {}), data: toSiteView(row as Row) };
};
