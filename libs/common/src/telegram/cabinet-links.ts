import { formatOrderNumber } from '../order/order-number';

/**
 * (PIJN1lGp) Botdagi «🌐 Kabinetda …» tugmalarining YAGONA manbasi — panel
 * manzili (`ELCHI_CABINET_URL`) va veb yo'llari. Yo'llar FE
 * `src/app/lib/routes.tsx` / `design/kit/route-map.json` dagi sahifalarga mos
 * (`WEB_ROUTES` — spec shu ro'yxat bilan solishtiradi). Veb manzili o'zgarsa,
 * shu fayl va `WEB_ROUTES` yangilanadi.
 */

/** Panel manzili sukuti (`ELCHI_CABINET_URL` berilmasa). */
export const DEFAULT_CABINET_URL = 'https://admin.elchipochta.uz';

/**
 * FE route'lari — `design/kit/route-map.json` dagi AYNAN satrlar (FE
 * origin/dev 16f27da8). `:orderId` — ichki buyurtma id (EL-raqam emas),
 * `:id` — smena id. Eski `/payments/shift-report/:id` ni FE yo'naltiradi;
 * yangi havolalarda `/payments/shifts/:id`.
 */
export const WEB_ROUTES = {
  home: '/',
  orderCreate: '/new-orders/create',
  orderEdit: '/orders/edit/:orderId',
  orders: '/orders',
  cashbox: '/cash-box',
  shiftReport: '/payments/shifts/:id',
} as const;

/**
 * Buyurtmalar ro'yxati filtri kalitlari (FE `ORDER_FILTER_KEYS`). Eski
 * `search` kaliti ISHLATILMAYDI — FE uni faqat eski havolalar uchun o'qiydi.
 */
export const ORDER_LIST_QUERY_KEYS = {
  search: 'orderSearch',
  status: 'status',
} as const;

/** `ELCHI_CABINET_URL` → toza `https://…` asos (oxirgi `/` siz); yaroqsiz yoki https emas → sukut. */
export function cabinetBaseUrl(raw?: string | null): string {
  const clean = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  return /^https:\/\/[\w.-]+(:\d+)?(\/[\w\-./]*)?$/.test(clean)
    ? clean
    : DEFAULT_CABINET_URL;
}

const fill = (route: string, id: string | number): string =>
  route.replace(/:[a-zA-Z]+/, encodeURIComponent(String(id)));

/** Kabinet yo'llari (asos bilan to'liq URL). */
export function cabinetLinks(rawBase?: string | null) {
  const base = cabinetBaseUrl(rawBase);
  return {
    base,
    /** Bosh sahifa (`/kun`, ofis rollari). */
    home: () => `${base}${WEB_ROUTES.home}`,
    /** «Buyurtma yaratish» sahifasi (AI buyurtma → «Kabinetda yaratish»). */
    orderCreate: () => `${base}${WEB_ROUTES.orderCreate}`,
    /** Buyurtma tafsiloti (guruh kartasi). */
    orderDetail: (orderId: string | number) =>
      `${base}${fill(WEB_ROUTES.orderEdit, orderId)}`,
    /**
     * Kuryer ro'yxati shu buyurtma bilan (kuryer kartasi, katta isbot,
     * qisman sotish — amal oynasi ro'yxatda). Qidiruv EL-raqam bilan.
     */
    courierOrder: (orderId: string | number) => {
      const query = new URLSearchParams({
        [ORDER_LIST_QUERY_KEYS.status]: 'waiting',
        [ORDER_LIST_QUERY_KEYS.search]:
          formatOrderNumber(orderId) ?? String(orderId),
      });
      return `${base}${WEB_ROUTES.orders}?${query.toString()}`;
    },
    /** O'z kassasi (kuryer / market to'lov xabarlari). */
    selfCashbox: () => `${base}${WEB_ROUTES.cashbox}`,
    /** Smena hisoboti (SA / admin / menejer; boshqalarni FE `/cash-box` ga). */
    shiftReport: (shiftId: string | number) =>
      `${base}${fill(WEB_ROUTES.shiftReport, shiftId)}`,
  };
}
