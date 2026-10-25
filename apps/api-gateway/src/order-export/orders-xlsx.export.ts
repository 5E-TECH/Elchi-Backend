/**
 * xWsCAA5N — `GET /orders/export/excel`: buyurtmalar ro'yxatining HAQIQIY
 * .xlsx eksporti, BITTA HTTP so'rov bilan (BeePost `GET orders/export/excel`
 * naqshi).
 *
 * NEGA SERVERDA. Frontend avval `GET /orders?page=N&limit=100` ni 100 marta
 * aylanib, 100-sahifada (10 000 qator) JIMGINA to'xtardi; `fetch_all=true`
 * esa 5000 bilan cheklangan (order-service MAX_FETCH_ALL) — kartadagi
 * ">10 000 buyurtma" holatiga yetmaydi. Kartaning qarori: 5000 yetmasa —
 * serverda stream endpoint.
 *
 * QANDAY:
 *   - qatorlar order-service'dan 500 talik sahifalar bilan olinadi va
 *     exceljs STREAM yozuvchisi orqali to'g'ridan javobga yoziladi — gateway
 *     xotirasida butun ro'yxat yig'ilmaydi;
 *   - doira (rol/market/filial/kuryer) GET /orders bilan AYNAN bir xil
 *     (gateway'dagi `resolveOrderListRequest`), rol proyeksiyasi ham;
 *   - `ORDER_EXPORT_MAX_ROWS` dan oshsa fayl birinchi N qator bilan chiqadi,
 *     lekin JIMGINA emas: `X-Export-Truncated: true` + `X-Export-Total`
 *     sarlavhalari va faylning o'zida "DIQQAT" qatori;
 *   - oxirida «Jami» (soni + narx yig'indisi) qatori.
 *
 * Birinchi sahifa olinmaguncha javobga hech narsa yozilmaydi — xato
 * (403/400/timeout) oddiy HTTP xato bo'lib qaytadi. Keyingi sahifada xato
 * bo'lsa oqim UZILADI (`res.destroy`) — brauzer yuklashni xato deb ko'rsatadi,
 * chala fayl "to'liq" bo'lib saqlanmaydi.
 */
import { Order_status } from '@app/common';
import { stream as excelStream } from 'exceljs';
import type { Writable } from 'node:stream';

/** Bitta eksport fayliga sig'adigan buyurtmalar chegarasi. */
export const ORDER_EXPORT_MAX_ROWS = 50_000;
/** order-service `max_limit` yuqori chegarasi (normalizePagination) — 500. */
export const ORDER_EXPORT_PAGE_SIZE = 500;
/** Bitta sahifa (500 boyitilgan qator) uchun RMQ kutish vaqti. */
export const ORDER_EXPORT_PAGE_TIMEOUT_MS = 30_000;
/** Cheksiz aylanishdan himoya (bo'sh bo'lmagan, lekin takroriy sahifalar). */
const ORDER_EXPORT_MAX_PAGES = 1_000;

export const ORDER_EXPORT_HEADERS = {
  total: 'X-Export-Total',
  limit: 'X-Export-Limit',
  truncated: 'X-Export-Truncated',
} as const;

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 9Bp7VtVj — «Holati» ustuni EKRANDAGI holat yorliqlari bilan AYNAN bir xil.
 *
 * Manba (frontend, dizayn v2): `src/entities/order/model/statusRegistry.ts`
 * `ORDER_STATUS_REGISTRY` (backend holati → `labelKey`) va
 * `src/locales/uz/status.json` → `order.*`. Har qator izohida — FE kaliti.
 * Eski `orders.json` (`statusCreated` = «Qabul qilingan» va h.k.) EMAS.
 * FE yorlig'i o'zgarsa — shu jadval va uning spec'i
 * (`order-gateway.export-excel.status-labels.9Bp7VtVj.spec.ts`) birga
 * yangilanadi. Eksport faqat o'zbekcha (sarlavhalar ham), til parametri yo'q.
 *
 * `Record<Order_status, …>` — backend'ga yangi holat qo'shilsa, yorliq
 * yozilmaguncha tsc yiqiladi (eksportda xom kod chiqib qolmasin).
 */
export const ORDER_EXPORT_STATUS_LABELS: Readonly<
  Record<Order_status, string>
> = {
  [Order_status.NEW]: 'Yangi', // order.new
  [Order_status.CREATED]: 'Yaratilgan', // order.created
  [Order_status.RECEIVED]: 'Qabul qilindi', // order.received
  [Order_status.ON_THE_ROAD]: "Yo'lda", // order.on_the_road
  [Order_status.WAITING]: 'Kutilmoqda', // order.waiting
  [Order_status.WAITING_CUSTOMER]: 'Mijoz kutilmoqda', // order.waiting_customer
  [Order_status.PARTLY_PAID]: "Qisman to'langan", // order.partly_paid
  [Order_status.SOLD]: 'Sotilgan', // order.sold
  [Order_status.PAID]: "To'langan", // order.paid
  [Order_status.CANCELLED]: 'Bekor qilingan', // order.cancelled
  [Order_status.CANCELLED_SENT]: "Bekor — jo'natilgan", // order.cancelled_sent
  [Order_status.RETURNED_TO_MARKET]: 'Marketga topshirildi', // order.returned_to_market
  [Order_status.CLOSED]: 'Yopilgan', // order.closed
};

/** Bo'sh holat — FE `order.unknown`. */
export const ORDER_EXPORT_UNKNOWN_STATUS_LABEL = "Noma'lum";

/**
 * FE `canonicalForm` bilan bir xil: kichik harf, `_`/`-`/qavs/bo'shliq →
 * bitta bo'shliq, `canceled` → `cancelled`, camelCase → so'zlar.
 */
const canonicalStatus = (raw: unknown): string =>
  typeof raw === 'string'
    ? raw
        .trim()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[\s_()-]+/g, ' ')
        .trim()
        .replace(/\bcanceled\b/g, 'cancelled')
    : '';

const STATUS_BY_SPELLING: ReadonlyMap<string, Order_status> = new Map(
  Object.values(Order_status).map((s) => [canonicalStatus(s), s] as const),
);

/** FE `normalizeOrderStatus`: `on_the_road`, `ON_THE_ROAD`, `cancelled_sent` … → holat. */
const normalizeStatus = (raw: unknown): Order_status | null =>
  STATUS_BY_SPELLING.get(canonicalStatus(raw)) ?? null;

/** FE `humanizeOrderStatus`: noma'lum `lost_in_transit` → «Lost in transit». */
const humanizeStatus = (raw: unknown): string | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const words = String(raw)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
};

/**
 * Buyurtma qatori → «Holati» yorlig'i, ekrandagi `OrderStatusBadge` kabi.
 * Ro'yxat qatorida jo'natilgan bekor `status: cancelled` +
 * `transport_status: 'cancelled (sent)'` bo'lib keladi (gateway
 * `normalizeOrderStatusForDisplay`) — FE `OrdersTable.getDisplayStatus` kabi
 * «Bekor — jo'natilgan» yoziladi.
 */
/**
 * 9Bp7VtVj (2-tur) — ro'yxatdagi bekor buyurtma belgisi holat nomini emas,
 * bekor BOSQICHINI ko'rsatadi (FE `OrderStatusBadge` + `cancelReturnStage.ts`):
 * `src/locales/uz/status.json` → `cancelStage.*`. Bosqich order-service
 * `return_stage` (BG1, 5Yy6r6UI) dan olinadi.
 */
export const ORDER_EXPORT_CANCEL_STAGE_LABELS: Readonly<
  Record<string, string>
> = {
  courier: 'Bekor · kuryerda', // cancelStage.courier
  in_transit: "Bekor · yo'lda", // cancelStage.in_transit
  branch: 'Bekor · filialda', // cancelStage.branch
  hq: "Bekor · HQ'da", // cancelStage.hq
  market: 'Marketga topshirildi', // cancelStage.market
};

/** Ombor buyurtmasi bekor bo'lib omborga qaytgan — cancelStage.warehouse. */
export const ORDER_EXPORT_WAREHOUSE_RETURN_LABEL = 'Omborga qaytdi';

const lowerText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().toLowerCase()
    : '';

/**
 * FE `isWarehouseReturn` bilan bir xil: ombor buyurtmasi (`fulfillment_source:
 * WAREHOUSE`) yakuniy «market» bosqichida — mahsulot marketga emas, omborga
 * qaytgan. Backend bosqichi bunday qatorda `null` (marketga topshirish emas).
 */
const isWarehouseReturn = (order: Record<string, unknown>): boolean => {
  if (lowerText(order.fulfillment_source) !== 'warehouse') return false;
  const stage = lowerText(order.return_stage);
  return (
    stage === 'market' ||
    (!stage &&
      normalizeStatus(order.status) === Order_status.RETURNED_TO_MARKET)
  );
};

export function orderExportStatusLabel(order: Record<string, unknown>): string {
  if (isWarehouseReturn(order)) return ORDER_EXPORT_WAREHOUSE_RETURN_LABEL;
  const stage = lowerText(
    order.return_stage ??
      (order.cancel_return as { stage?: unknown } | null | undefined)?.stage,
  );
  if (stage && ORDER_EXPORT_CANCEL_STAGE_LABELS[stage]) {
    return ORDER_EXPORT_CANCEL_STAGE_LABELS[stage];
  }
  const transport = normalizeStatus(
    order.transport_status ?? order.transportStatus,
  );
  const status =
    transport === Order_status.CANCELLED_SENT
      ? transport
      : normalizeStatus(order.status);
  if (status) return ORDER_EXPORT_STATUS_LABELS[status];
  return humanizeStatus(order.status) ?? ORDER_EXPORT_UNKNOWN_STATUS_LABEL;
}

export const ORDER_EXPORT_COLUMNS: Array<{
  header: string;
  key: string;
  width: number;
}> = [
  { header: 'N', key: 'n', width: 8 },
  { header: 'Buyurtma ID', key: 'id', width: 12 },
  { header: 'Viloyat', key: 'region', width: 18 },
  { header: 'Tuman', key: 'district', width: 18 },
  { header: 'Firma', key: 'market', width: 22 },
  { header: 'Mahsulot', key: 'products', width: 36 },
  { header: 'Mijoz', key: 'customer', width: 22 },
  { header: 'Telefon raqam', key: 'phone', width: 16 },
  { header: 'Narxi', key: 'total_price', width: 14 },
  { header: 'Kuryer', key: 'courier', width: 22 },
  { header: 'Holati', key: 'status', width: 16 },
  { header: 'Sana', key: 'created_at', width: 18 },
];

export interface OrderExportPage {
  rows: Array<Record<string, unknown>>;
  total: number;
  /** order-service: qidiruvga 1000 dan ortiq mijoz mos keldi. */
  searchTruncated?: boolean;
}

export interface OrderExportResponse extends Writable {
  setHeader(name: string, value: string): unknown;
  readonly headersSent?: boolean;
}

export interface OrderExportResult {
  status: 'completed' | 'aborted';
  total: number;
  written: number;
  truncated: boolean;
  error?: unknown;
}

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;

const text = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
};

const money = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Toshkent (UTC+5, yozgi vaqt yo'q) — `YYYY-MM-DD HH:mm`. */
export const formatTashkentDateTime = (value: unknown): string => {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : '';
  }
  return new Date(date.getTime() + 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
};

const productNames = (order: Obj): string => {
  const items = Array.isArray(order.items) ? (order.items as unknown[]) : [];
  const names = items
    .map((raw) => {
      const item = obj(raw) ?? {};
      const product = obj(item.product) ?? {};
      return text(product.name, item.product_name, item.name, product.title);
    })
    .filter(Boolean);
  if (names.length) return names.join(', ');
  return text(obj(order.product)?.name, order.product_name);
};

/** Bitta buyurtma → eksport qatori (frontend exportOrdersToExcel bilan mos). */
export function toOrderExportRow(order: Obj, index: number): Obj {
  const customer = obj(order.customer) ?? {};
  const customerDistrict = obj(customer.district) ?? {};
  const district = obj(order.district) ?? {};
  return {
    n: index,
    id: text(order.id),
    region: text(
      obj(order.region)?.name,
      obj(district.region)?.name,
      obj(customer.region)?.name,
      obj(customerDistrict.region)?.name,
    ),
    district: text(district.name, customerDistrict.name),
    market: text(obj(order.market)?.name, order.market_name),
    products: productNames(order),
    customer: text(customer.name),
    phone: text(customer.phone_number, order.phone_number),
    total_price: money(order.total_price),
    courier: text(
      obj(order.courier)?.name,
      obj(order.courier)?.full_name,
      order.courier_name,
    ),
    status: orderExportStatusLabel(order),
    created_at: formatTashkentDateTime(order.createdAt ?? order.created_at),
  };
}

const formatCount = (n: number) =>
  String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export const orderExportFileName = (now: Date = new Date()) =>
  `barcha_buyurtmalar_${formatTashkentDateTime(now).slice(0, 10)}.xlsx`;

/**
 * Sahifalarni ketma-ket o'qib, .xlsx ni `res` ga oqim bilan yozadi.
 * Birinchi sahifadagi xato TASHQARIGA otiladi (javob hali boshlanmagan);
 * keyingilarida oqim uziladi va `status: 'aborted'` qaytadi.
 */
export async function streamOrdersXlsx(
  res: OrderExportResponse,
  fetchPage: (page: number) => Promise<OrderExportPage>,
  options: { maxRows?: number; now?: Date } = {},
): Promise<OrderExportResult> {
  const maxRows = options.maxRows ?? ORDER_EXPORT_MAX_ROWS;

  const first = await fetchPage(1);
  const total = Math.max(0, Math.trunc(Number(first.total) || 0));
  const truncated = total > maxRows;
  let searchTruncated = Boolean(first.searchTruncated);

  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${orderExportFileName(options.now)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(ORDER_EXPORT_HEADERS.total, String(total));
  res.setHeader(ORDER_EXPORT_HEADERS.limit, String(maxRows));
  res.setHeader(ORDER_EXPORT_HEADERS.truncated, truncated ? 'true' : 'false');

  const workbook = new excelStream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.created = options.now ?? new Date();
  const sheet = workbook.addWorksheet('Buyurtmalar', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = ORDER_EXPORT_COLUMNS.map((c) => ({ ...c }));
  sheet.getColumn('total_price').numFmt = '#,##0';
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFC000' },
  };
  header.commit();

  const seen = new Set<string>();
  let written = 0;
  let sum = 0;

  try {
    let batch = first;
    for (let page = 1; page <= ORDER_EXPORT_MAX_PAGES; page++) {
      if (page > 1) {
        batch = await fetchPage(page);
        searchTruncated = searchTruncated || Boolean(batch.searchTruncated);
      }
      const rows = Array.isArray(batch.rows) ? batch.rows : [];
      for (const order of rows) {
        if (written >= maxRows) break;
        const id = text(order?.id);
        // Eksport paytida yangi buyurtma qo'shilsa sahifalar suriladi —
        // bir buyurtma ikki marta yozilmasin.
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        written += 1;
        const row = toOrderExportRow(order, written);
        sum += Number(row.total_price) || 0;
        sheet.addRow(row).commit();
      }
      if (!rows.length || written >= maxRows || seen.size >= total) break;
    }

    const totalRow = sheet.addRow({
      n: 'Jami',
      products: `${formatCount(written)} ta buyurtma`,
      total_price: sum,
    });
    totalRow.font = { bold: true };
    totalRow.commit();

    const warnings: string[] = [];
    if (truncated) {
      warnings.push(
        `DIQQAT: eksport ${formatCount(maxRows)} ta buyurtma bilan cheklangan — ` +
          `filtr bo'yicha jami ${formatCount(total)} ta, faylda faqat ` +
          `birinchi ${formatCount(written)} tasi. To'liq ro'yxat uchun sana, ` +
          'holat yoki market filtri bilan toraytirib, qismlab eksport qiling.',
      );
    } else if (written < total) {
      warnings.push(
        `DIQQAT: eksport paytida ro'yxat o'zgardi — kutilgan ${formatCount(total)} ` +
          `ta, faylda ${formatCount(written)} ta. Eksportni qayta bajaring.`,
      );
    }
    if (searchTruncated) {
      warnings.push(
        'DIQQAT: qidiruvga 1 000 dan ortiq mijoz mos keldi — faqat birinchi 1 000 mijozning buyurtmalari kiritildi. Qidiruvni aniqlashtiring.',
      );
    }
    for (const warning of warnings) {
      const row = sheet.addRow({ n: warning });
      row.font = { bold: true, color: { argb: 'FFC00000' } };
      row.commit();
    }

    sheet.commit();
    await workbook.commit();
    return { status: 'completed', total, written, truncated };
  } catch (error) {
    // Javob allaqachon boshlangan: chala faylni "muvaffaqiyatli" yuklab
    // olinmasin — ulanish uziladi.
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    return { status: 'aborted', total, written, truncated, error };
  }
}
