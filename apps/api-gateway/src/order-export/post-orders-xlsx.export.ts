/**
 * Eski pochta — `GET /post/:id/orders.xlsx`: pochtaga HAR QACHON kirgan
 * buyurtmalar ro'yxati (logistics `logistics.post.orders_by_post`, `view:
 * 'all'`).
 *
 * Ustunlar buyurtmalar eksporti bilan BIR XIL (`ORDER_EXPORT_COLUMNS`,
 * `toOrderExportRow` — «Holati» ham ekrandagi yorliq) + pochta tarixi:
 * «Pochtaga kirgan», «Pochtadan chiqqan», «Hozir pochtada» (ha/yo'q),
 * «Hozirgi holat» (holat + hozir qaysi pochtada).
 *
 * Qatorlar gateway xotirasida (logistics bitta javobda beradi, `find_all`
 * 5000 chegarasi) — sahifalash yo'q. LOGIST (ega LG-S1, moliyaga
 * aralashmaydi): pul ustuni ham, «Jami» summasi ham yo'q.
 */
import { stream as excelStream } from 'exceljs';
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_HEADERS,
  XLSX_CONTENT_TYPE,
  formatCount,
  formatTashkentDateTime,
  orderExportStatusLabel,
  toOrderExportRow,
  type OrderExportResponse,
} from './orders-xlsx.export';

type Obj = Record<string, unknown>;

/** Pochta tarixi ustunlari (buyurtma eksporti ustunlaridan keyin). */
export const POST_ORDER_EXPORT_EXTRA_COLUMNS: Array<{
  header: string;
  key: string;
  width: number;
}> = [
  { header: 'Pochtaga kirgan', key: 'joined_at', width: 18 },
  { header: 'Pochtadan chiqqan', key: 'left_at', width: 18 },
  { header: 'Hozir pochtada', key: 'in_post_now', width: 14 },
  { header: 'Hozirgi holat', key: 'current_state', width: 34 },
];

/** Logistga chiqmaydigan (pul) ustunlar. */
export const ORDER_EXPORT_MONEY_COLUMN_KEYS: readonly string[] = [
  'total_price',
];

const obj = (value: unknown): Obj | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;

const idText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Pochta eksporti ustunlari; `hideMoney` — pul ustunlarisiz (LOGIST). */
export function postOrderExportColumns(options: { hideMoney?: boolean } = {}) {
  return [
    ...ORDER_EXPORT_COLUMNS.filter(
      (column) =>
        !options.hideMoney ||
        !ORDER_EXPORT_MONEY_COLUMN_KEYS.includes(column.key),
    ),
    ...POST_ORDER_EXPORT_EXTRA_COLUMNS,
  ].map((column) => ({ ...column }));
}

/** Buyurtma hozir shu pochtadami (logistics `in_post_now`; yo'q — joriy a'zo). */
export function isInPostNow(order: Obj): boolean {
  return order.in_post_now !== false;
}

/**
 * «Hozir qayerda»: shu pochtada / boshqa pochtada (`#id`) / qaytarish
 * pochtasida / pochtada emas. Manba — logistics `current_post_id`,
 * `current_canceled_post_id` (buyurtmaning hozirgi ko'rsatkichlari).
 */
export function postOrderLocationLabel(order: Obj, postId: string): string {
  if (isInPostNow(order)) return 'shu pochtada';
  const self = idText(postId);
  const canceledPostId = idText(
    order.current_canceled_post_id ?? order.canceled_post_id,
  );
  if (canceledPostId && canceledPostId !== self) {
    return `qaytarish pochtasi #${canceledPostId}`;
  }
  const currentPostId = idText(order.current_post_id ?? order.post_id);
  if (currentPostId && currentPostId !== self) {
    return `pochta #${currentPostId}`;
  }
  return 'pochtada emas';
}

/** «Hozirgi holat»: ekrandagi holat yorlig'i + hozir qayerda. */
export function postOrderCurrentStateLabel(order: Obj, postId: string): string {
  return `${orderExportStatusLabel(order)} · ${postOrderLocationLabel(order, postId)}`;
}

/**
 * Bitta buyurtma → pochta eksporti qatori. `courierName` — pochta kuryeri
 * (buyurtma qatorida kuryer bo'lmasa, «Kuryer» ustuni shundan).
 */
export function toPostOrderExportRow(
  order: Obj,
  index: number,
  options: { postId: string; hideMoney?: boolean; courierName?: string },
): Obj {
  const base = toOrderExportRow(order, index);
  const membership = obj(order.membership) ?? {};
  const inPostNow = isInPostNow(order);
  const row: Obj = {
    ...base,
    courier: base.courier || options.courierName || '',
    joined_at: formatTashkentDateTime(membership.joined_at),
    // Hali pochtada — chiqish vaqti yo'q.
    left_at: inPostNow ? '' : formatTashkentDateTime(membership.left_at),
    in_post_now: inPostNow ? 'ha' : "yo'q",
    current_state: postOrderCurrentStateLabel(order, options.postId),
  };
  if (options.hideMoney) {
    for (const key of ORDER_EXPORT_MONEY_COLUMN_KEYS) delete row[key];
  }
  return row;
}

/** `pochta-<id>-<YYYY-MM-DD>.xlsx` (Toshkent kuni). */
export const postOrdersXlsxFileName = (
  postId: string,
  now: Date = new Date(),
) =>
  `pochta-${String(postId).replace(/[^0-9A-Za-z_-]/g, '')}-${formatTashkentDateTime(now).slice(0, 10)}.xlsx`;

export interface PostOrdersXlsxInput {
  postId: string;
  rows: Obj[];
  /** LOGIST — pul ustuni va «Jami» summasi yo'q. */
  hideMoney?: boolean;
  /** logistics `history_incomplete` — tarix olinmadi, faylda DIQQAT qatori. */
  historyIncomplete?: boolean;
  courierName?: string;
  now?: Date;
}

/**
 * Pochta buyurtmalarini .xlsx qilib `res` ga yozadi (exceljs stream).
 * Yozish boshlangach xato bo'lsa ulanish uziladi (chala fayl "to'liq" bo'lib
 * saqlanmasin) va `aborted` qaytadi.
 */
export async function writePostOrdersXlsx(
  res: OrderExportResponse,
  input: PostOrdersXlsxInput,
): Promise<{
  status: 'completed' | 'aborted';
  written: number;
  error?: unknown;
}> {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const hideMoney = Boolean(input.hideMoney);

  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${postOrdersXlsxFileName(input.postId, input.now)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(ORDER_EXPORT_HEADERS.total, String(rows.length));

  let written = 0;
  try {
    const workbook = new excelStream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: false,
    });
    workbook.created = input.now ?? new Date();
    const sheet = workbook.addWorksheet('Buyurtmalar', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = postOrderExportColumns({ hideMoney });
    if (!hideMoney) sheet.getColumn('total_price').numFmt = '#,##0';
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFC000' },
    };
    header.commit();

    let sum = 0;
    let inPostNow = 0;
    for (const order of rows) {
      written += 1;
      const row = toPostOrderExportRow(order, written, {
        postId: input.postId,
        hideMoney,
        courierName: input.courierName,
      });
      if (!hideMoney) sum += Number(row.total_price) || 0;
      if (isInPostNow(order)) inPostNow += 1;
      sheet.addRow(row).commit();
    }

    const totalRow = sheet.addRow({
      n: 'Jami',
      products: `${formatCount(written)} ta buyurtma`,
      in_post_now: `${formatCount(inPostNow)} ta`,
      ...(hideMoney ? {} : { total_price: sum }),
    });
    totalRow.font = { bold: true };
    totalRow.commit();

    if (input.historyIncomplete) {
      const warning = sheet.addRow({
        n: "DIQQAT: pochta tarixi to'liq olinmadi — ro'yxatda faqat hozir pochtadagi buyurtmalar bo'lishi mumkin. Birozdan so'ng qayta yuklab oling.",
      });
      warning.font = { bold: true, color: { argb: 'FFC00000' } };
      warning.commit();
    }

    sheet.commit();
    await workbook.commit();
    return { status: 'completed', written };
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    return { status: 'aborted', written, error };
  }
}
