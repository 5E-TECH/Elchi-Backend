/**
 * Carrier API'da tashqi kompaniyaga qaytadigan buyurtma ko'rinishi.
 *
 * ⚠️ NEGA ICHKI BUYURTMA QATORI QAYTARILMAYDI. `order.find_by_*_enriched`
 * javobida o'nlab ichki maydon bor (filial qatori, market profili, kassa
 * summalari, holder/custody, tarif snapshotlari). Ular (a) tashqi kompaniyaga
 * tegishli emas va (b) ichki refaktorda o'zgaradi — tashqi integratsiya esa
 * barqaror kontraktga muhtoj. Shu sababli bu yerda ANIQ ro'yxat (allowlist):
 * yangi ichki maydon avtomatik ravishda tashqariga chiqmaydi.
 *
 * Kontrakt: docs/public/CARRIER_API.md §4.
 */
export type CarrierOrderView = {
  id: string;
  order_number: string | null;
  qr_token: string | null;
  parent_order_id: string | null;
  status: string;
  /** Buyurtma summasi (so'm). */
  total_price: number;
  /** Oldindan onlayn to'langan qism (so'm). */
  paid_online_amount: number;
  /** Mijozdan naqd olinadigan summa = total_price − paid_online_amount. */
  cod_amount: number;
  where_deliver: string | null;
  address: string | null;
  comment: string | null;
  customer: {
    name: string | null;
    phone_number: string | null;
    extra_number: string | null;
  } | null;
  /**
   * Viloyat va tuman — NOM EMAS, SOATO KODI bilan (ega qarori, 2026-11-10):
   * tashqi tizim geo'ni o'z ma'lumotnomasiga SOATO bo'yicha moslaydi; nom
   * yozilishi (lotin/kirill, "sh." qisqartmalari) farq qiladi va mos
   * kelmaydi. `id` — Elchi ichki id'si (murojaat va qo'llab-quvvatlash uchun).
   */
  region: CarrierGeoRef | null;
  district: CarrierGeoRef | null;
  market: { id: string; name: string | null } | null;
  /**
   * Almashtirish buyurtmasi (eski mahsulot mijozdan olinishi kerak) yoki
   * `null`. `old_item_required: true` bo'lsa sotuvda `old_item_collected:
   * true` SHART (aks holda 400) — ilgari bu ko'rinmasdi va kompaniya sababini
   * bilolmasdi.
   */
  replacement: CarrierReplacement | null;
  items: Array<{
    id: string;
    product_id: string | null;
    name: string | null;
    quantity: number;
  }>;
  created_at: string | null;
};

/** Viloyat/tuman: Elchi id va rasmiy SOATO kodi (`sato_code` ustuni). */
export type CarrierGeoRef = { id: string; soato_code: string | null };

export type CarrierReplacement = {
  /** Qaysi buyurtma o'rniga (eski buyurtma id). */
  of_order_id: string;
  /** Eski mahsulot hali olinmagan — sotishda `old_item_collected: true` shart. */
  old_item_required: boolean;
};

/** order-service `OrderReplacementState`: eski mahsulot olingan / qaytarilgan. */
const REPLACEMENT_DONE_STATES = new Set(['old_collected', 'old_returned']);

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
};

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const ref = (value: unknown): { id: string; name: string | null } | null => {
  if (!isRow(value)) return null;
  const id = str(value.id);
  return id ? { id, name: str(value.name) } : null;
};

/**
 * Viloyat/tuman → `{ id, soato_code }`. Nom ATAYLAB chiqmaydi. logistics
 * entity'sida ustun `sato_code`; tashqi kontraktda rasmiy atama `soato_code`.
 */
const geoRef = (value: unknown, digits: 4 | 7): CarrierGeoRef | null => {
  if (!isRow(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  /**
   * Faqat haqiqiy SOATO (viloyat 4 xona, tuman 7 xona). Bazada `sato_code`
   * ixtiyoriy va eski `REG-xx-DIS-yy` kabi soxta qiymatlar qolgan bo'lishi
   * mumkin — ular tashqariga "SOATO" bo'lib chiqmasin: `null` (kod noma'lum).
   */
  const code = str(value.sato_code ?? value.soato_code);
  const pattern = digits === 4 ? /^\d{4}$/ : /^\d{7}$/;
  const valid = code !== null && pattern.test(code);
  return { id, soato_code: valid ? code : null };
};

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return str(value);
};

/**
 * RMQ javobidan buyurtma qatorini ajratadi: `{ statusCode, data: order }`
 * qobig'i ham (`find_by_qr_enriched`), qobiqsiz qator ham
 * (`find_by_id_enriched`) qabul qilinadi.
 */
export function unwrapOrderRow(response: unknown): Row | null {
  if (!isRow(response)) return null;
  if ('statusCode' in response && 'data' in response) {
    return isRow(response.data) ? response.data : null;
  }
  return 'id' in response ? response : null;
}

/** `'0'` va bo'sh qiymat — kurier yo'q (order-service bilan bir xil qoida). */
const courierIdOf = (value: unknown): string => {
  const id = str(value) ?? '';
  return id === '0' ? '' : id;
};

/**
 * Buyurtma SHU kurierdami: `courier_id` (biriktirilgan) yoki
 * `holder_courier_id` (posilka hozir qo'lida — masalan bekor qilingan,
 * hali qaytarilmagan). Order-service'dagi kurier egalik tekshiruvi bilan
 * mos (`resolveActorCourierId`).
 */
export function isOrderHeldByCourier(row: Row, courierId: string): boolean {
  const target = String(courierId ?? '').trim();
  if (!target) return false;
  return (
    courierIdOf(row.courier_id) === target ||
    courierIdOf(row.holder_courier_id) === target
  );
}

/**
 * Geo boyitish yetib kelmaganmi (SOATO jimgina `null` bo'lib qolmasin).
 *
 * order-service `enrichOrders` logistics xatosida bo'sh xarita bilan davom
 * etadi (`.catch(() => ({ data: [] }))`) — buyurtmada `region_id`/
 * `district_id` bor, lekin `region`/`district` obyekti yo'q. Carrier yo'lida
 * bu "viloyat yo'q" emas, VAQTINCHALIK xato: chaqiruvchi qayta o'qiydi yoki
 * 503 qaytaradi.
 */
export function isGeoIncomplete(row: Row): boolean {
  const missing = (idKey: string, objKey: string) => {
    const obj = row[objKey];
    return !!str(row[idKey]) && !(isRow(obj) && str(obj.id));
  };
  return missing('region_id', 'region') || missing('district_id', 'district');
}

/**
 * Boyitish to'liqmi — geo bilan bir xil sabab: `enrichOrders` identity
 * (mijoz, market) xatosida ham bo'sh xarita bilan davom etadi. Carrier
 * yo'lida mijoz ismi/telefonisiz yoki marketsiz buyurtma "ma'lumot yo'q"
 * emas, VAQTINCHALIK xato — chaqiruvchi qayta o'qiydi yoki 503 qaytaradi.
 */
export function isEnrichmentIncomplete(row: Row): boolean {
  if (isGeoIncomplete(row)) return true;
  const customer = row.customer;
  if (
    str(row.customer_id) &&
    !(isRow(customer) && (str(customer.name) || str(customer.phone_number)))
  ) {
    return true;
  }
  const market = row.market;
  return !!str(row.market_id) && !(isRow(market) && str(market.id));
}

const replacementOf = (row: Row): CarrierReplacement | null => {
  const ofOrderId = str(row.replacement_of_order_id);
  if (!ofOrderId) return null;
  const state = (str(row.replacement_state) ?? '').toLowerCase();
  return {
    of_order_id: ofOrderId,
    old_item_required: !REPLACEMENT_DONE_STATES.has(state),
  };
};

export function toCarrierOrderView(row: Row): CarrierOrderView {
  const total = num(row.total_price);
  const paidOnline = Math.min(Math.max(num(row.paid_online_amount), 0), total);
  const customer = isRow(row.customer) ? row.customer : null;
  const items = Array.isArray(row.items) ? row.items.filter(isRow) : [];

  return {
    id: str(row.id) ?? '',
    order_number: str(row.order_number),
    qr_token: str(row.qr_code_token),
    parent_order_id: str(row.parent_order_id),
    status: str(row.status) ?? '',
    total_price: total,
    paid_online_amount: paidOnline,
    cod_amount: total - paidOnline,
    where_deliver: str(row.where_deliver),
    address: str(row.address) ?? str(customer?.address),
    comment: str(row.comment),
    customer: customer
      ? {
          name: str(customer.name),
          phone_number: str(customer.phone_number),
          extra_number: str(customer.extra_number) ?? str(row.extra_number),
        }
      : null,
    region: geoRef(row.region, 4),
    district: geoRef(row.district, 7),
    market: ref(row.market),
    replacement: replacementOf(row),
    items: items.map((item) => ({
      id: str(item.id) ?? '',
      product_id: str(item.product_id),
      name:
        str(item.product_name) ??
        (isRow(item.product) ? str(item.product.name) : null),
      quantity: num(item.quantity),
    })),
    created_at: iso(row.createdAt ?? row.created_at),
  };
}
