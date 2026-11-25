/**
 * Eski pochta — `GET /post/:id/orders.xlsx`: pochtaga HAR QACHON kirgan
 * buyurtmalar ro'yxati (logistics `logistics.post.orders_by_post`, `view:
 * 'all'`).
 *
 * Ustunlar buyurtmalar eksporti bilan BIR XIL (`ORDER_EXPORT_COLUMNS`,
 * `toOrderExportRow` — «Holati» ham ekrandagi yorliq) + pochta tarixi:
 * «Pochtaga kirgan», «Pochtadan chiqqan», «Hozir pochtada» (ha/yo'q),
 * «Hozirgi holat» (holat + hozir qaysi pochtada). 2-varaq — «Xulosa».
 *
 * Qatorlar gateway xotirasida (logistics bitta javobda beradi, `find_all`
 * 5000 chegarasi) — sahifalash yo'q. LOGIST (ega LG-S1, moliyaga
 * aralashmaydi): pul ustuni ham, hech qanday summa ham yo'q — «Xulosa» da ham
 * faqat soni va ulushi.
 */
import {
  REPORT_COLORS,
  REPORT_FMT,
  addReportSheet,
  formula,
} from '@app/report-kit';
import {
  LIST_COUNT_FMT,
  ReportList,
  ReportTally,
  SUMMARY_WIDTHS,
  addAttention,
  addCards,
  addShareTable,
  addSlimKpis,
  addTextBanner,
  countFormat,
  createStreamReport,
  reportDateTime,
  type ReportListColumn,
  type ReportShareTable,
} from '@app/report-kit/stream';
import type { Workbook } from 'exceljs';
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_HEADERS,
  ORDER_EXPORT_STATUS_ORDER,
  ORDER_EXPORT_UNKNOWN_STATUS_LABEL,
  XLSX_CONTENT_TYPE,
  formatCount,
  formatTashkentDateTime,
  orderExportDate,
  orderExportStatusLabel,
  orderExportStatusTone,
  toOrderExportRow,
  type OrderExportResponse,
} from './orders-xlsx.export';

type Obj = Record<string, unknown>;

/** Pochta tarixi ustunlari (buyurtma eksporti ustunlaridan keyin). */
export const POST_ORDER_EXPORT_EXTRA_COLUMNS: readonly ReportListColumn[] = [
  {
    header: 'Pochtaga kirgan',
    key: 'joined_at',
    width: 16.5,
    fmt: REPORT_FMT.dateTime,
  },
  {
    header: 'Pochtadan chiqqan',
    key: 'left_at',
    width: 16.5,
    fmt: REPORT_FMT.dateTime,
  },
  {
    header: 'Hozir pochtada',
    key: 'in_post_now',
    width: 10.5,
    badge: true,
    tone: (row) => (row.in_post_now === 'ha' ? 'success' : 'neutral'),
  },
  { header: 'Hozirgi holat', key: 'current_state', width: 26, wrap: true },
];

/** Buyurtma ustunlari pochta faylida ixchamroq (16 ustun bitta betga). */
const POST_COLUMN_LAYOUT: Readonly<Record<string, Partial<ReportListColumn>>> =
  {
    n: { width: 5.5 },
    region: { width: 11, wrap: true },
    district: { width: 12.5, wrap: true },
    market: { width: 12.5, wrap: true },
    products: { width: 23 },
    customer: { width: 11.5, wrap: true },
    total_price: { width: 13 },
    courier: { width: 11.5, wrap: true },
    status: { width: 17, wrap: true },
    created_at: { width: 16.5, color: undefined },
  };

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
export function postOrderExportColumns(
  options: { hideMoney?: boolean } = {},
): ReportListColumn[] {
  return [
    ...ORDER_EXPORT_COLUMNS.filter(
      (column) =>
        !options.hideMoney ||
        !ORDER_EXPORT_MONEY_COLUMN_KEYS.includes(column.key),
    ).map((column) => ({ ...column, ...POST_COLUMN_LAYOUT[column.key] })),
    ...POST_ORDER_EXPORT_EXTRA_COLUMNS.map((column) => ({ ...column })),
  ];
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
    joined_at: orderExportDate(membership.joined_at),
    // Hali pochtada — chiqish vaqti yo'q.
    left_at: inPostNow ? '' : orderExportDate(membership.left_at),
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
  /** LOGIST — pul ustuni va hech qanday summa yo'q («Xulosa» da ham). */
  hideMoney?: boolean;
  /** logistics `history_incomplete` — tarix olinmadi, faylda DIQQAT qatori. */
  historyIncomplete?: boolean;
  courierName?: string;
  now?: Date;
}

const HISTORY_WARNING =
  "DIQQAT: pochta tarixi to'liq olinmadi — ro'yxatda faqat hozir pochtadagi buyurtmalar bo'lishi mumkin. Birozdan so'ng qayta yuklab oling.";
const HISTORY_SUMMARY_WARNING =
  "DIQQAT: pochta tarixi to'liq olinmadi — sonlar faqat hozir pochtadagi buyurtmalar bo'yicha bo'lishi mumkin.";

/** Xulosa: «Boshqalar» gacha ko'rsatiladigan guruhlar soni. */
const SUMMARY_TOP = 15;
const SUMMARY_MAX = 60;

const label = (value: unknown) => (typeof value === 'string' ? value : '');
const upperFirst = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/** Pochta «Xulosa» si yig'uvchilari. `hideMoney` — summa umuman yig'ilmaydi. */
class PostOrdersTotals {
  count = 0;
  sum = 0;
  inPostNow = 0;
  inPostNowSum = 0;
  readonly statuses = new ReportTally(ORDER_EXPORT_UNKNOWN_STATUS_LABEL);
  readonly places = new ReportTally();
  readonly districts = new ReportTally();
  readonly markets = new ReportTally();

  add(row: Obj, place: string, inPostNow: boolean): void {
    const price = Number(row.total_price) || 0;
    this.count += 1;
    this.sum += price;
    if (inPostNow) {
      this.inPostNow += 1;
      this.inPostNowSum += price;
    }
    this.statuses.add(label(row.status), price);
    this.places.add(upperFirst(place), price);
    this.districts.add(label(row.district), price);
    this.markets.add(label(row.market), price);
  }
}

function writePostSummary(
  workbook: Workbook,
  totals: PostOrdersTotals,
  o: {
    postId: string;
    subtitle: string;
    hideMoney: boolean;
    historyIncomplete: boolean;
    now: Date;
  },
): void {
  const sheet = addReportSheet(workbook, 'Xulosa', SUMMARY_WIDTHS, {
    tab: REPORT_COLORS.action,
    footer: `Pochta №${o.postId} — xulosa`,
  });
  const left = totals.count - totals.inPostNow;
  const orders = (value: number) => `${formatCount(value)} ta buyurtma`;
  let r = addTextBanner(sheet, {
    title: `Pochta №${o.postId} xulosasi`,
    subtitle: o.subtitle,
    right: `${formatCount(totals.count)} ta`,
    rightSub: reportDateTime(o.now),
  });
  if (o.historyIncomplete) {
    r = addAttention(sheet, r, HISTORY_SUMMARY_WARNING);
    sheet.getRow(r).height = 8;
    r += 1;
  }
  r = o.hideMoney
    ? addCards(sheet, r, [
        { label: 'Jami buyurtma', value: totals.count, fmt: LIST_COUNT_FMT },
        {
          label: 'Hozir pochtada',
          value: totals.inPostNow,
          fmt: LIST_COUNT_FMT,
          tone: 'success',
        },
        {
          label: 'Pochtadan chiqqan',
          value: o.historyIncomplete ? '—' : left,
          fmt: LIST_COUNT_FMT,
          ...(o.historyIncomplete
            ? { tone: 'warning' as const, sub: "tarix to'liq emas" }
            : {}),
        },
      ])
    : addCards(sheet, r, [
        {
          label: "Jami narxi, so'm",
          value: totals.sum,
          sub: orders(totals.count),
        },
        {
          label: "Hozir pochtada, so'm",
          value: totals.inPostNowSum,
          tone: 'success',
          sub: orders(totals.inPostNow),
        },
        {
          label: "Pochtadan chiqqan, so'm",
          value: o.historyIncomplete ? '—' : totals.sum - totals.inPostNowSum,
          ...(o.historyIncomplete
            ? { tone: 'warning' as const, sub: "tarix to'liq emas" }
            : { sub: orders(left) }),
        },
      ]);
  const table: Pick<ReportShareTable, 'money' | 'spans'> = o.hideMoney
    ? { money: false, spans: [2, 1, 1, 2, 0] }
    : { money: true };
  r = addShareTable(sheet, r, {
    ...table,
    title: "Holatlar bo'yicha",
    head: 'Holati',
    rows: totals.statuses.list({
      order: ORDER_EXPORT_STATUS_ORDER,
      tone: orderExportStatusTone,
    }),
    badge: true,
  });
  r = addShareTable(sheet, r, {
    ...table,
    title: 'Hozir qayerda',
    head: 'Joyi',
    rows: totals.places.list({ top: SUMMARY_MAX }),
  });
  r = addShareTable(sheet, r, {
    ...table,
    title: "Tumanlar bo'yicha",
    head: 'Tuman',
    rows: totals.districts.list({ top: SUMMARY_MAX }),
  });
  addShareTable(sheet, r, {
    ...table,
    title: "Firmalar bo'yicha",
    head: 'Firma',
    rows: totals.markets.list({ top: SUMMARY_TOP }),
  });
  sheet.commit();
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
  const historyIncomplete = Boolean(input.historyIncomplete);
  const now = input.now ?? new Date();

  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${postOrdersXlsxFileName(input.postId, input.now)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(ORDER_EXPORT_HEADERS.total, String(rows.length));

  let written = 0;
  try {
    const columns = postOrderExportColumns({ hideMoney });
    const inPostNow = rows.filter(isInPostNow).length;
    const courier = input.courierName?.trim()
      ? `Kuryer: ${input.courierName.trim()}`
      : '';
    const headRow = historyIncomplete ? 11 : 9;
    const workbook = createStreamReport(
      res,
      `Pochta №${input.postId} buyurtmalari`,
      now,
    );
    const sheet = addReportSheet(
      workbook,
      'Buyurtmalar',
      columns.map((column) => column.width),
      {
        orientation: 'landscape',
        freeze: headRow,
        freezeColumns: 3,
        footer: `Pochta №${input.postId}`,
      },
    );
    let r = addTextBanner(sheet, {
      title: `Pochta №${input.postId} — buyurtmalar ro'yxati`,
      subtitle: ['Pochtaga har qachon kirgan buyurtmalar', courier]
        .filter(Boolean)
        .join(' · '),
      right: `${formatCount(rows.length)} ta buyurtma`,
      rightSub: `${reportDateTime(now)} da yuklandi`,
    });
    if (historyIncomplete) {
      r = addAttention(sheet, r, HISTORY_WARNING, 28);
      sheet.getRow(r).height = 6;
      r += 1;
    }
    r = addSlimKpis(sheet, r, [
      { label: 'Jami buyurtma', value: rows.length, fmt: LIST_COUNT_FMT },
      {
        label: 'Hozir pochtada',
        value: inPostNow,
        fmt: LIST_COUNT_FMT,
        tone: 'success',
      },
      {
        label: 'Pochtadan chiqqan',
        value: historyIncomplete ? '—' : rows.length - inPostNow,
        fmt: LIST_COUNT_FMT,
        ...(historyIncomplete ? { tone: 'warning' as const } : {}),
      },
    ]);
    const list = new ReportList(sheet, columns);
    list.header(r, 28);
    sheet.getRow(r).commit();
    r += 1;
    const firstRow = r;

    const totals = new PostOrdersTotals();
    for (const order of rows) {
      written += 1;
      const row = toPostOrderExportRow(order, written, {
        postId: input.postId,
        hideMoney,
        courierName: input.courierName,
      });
      const inNow = isInPostNow(order);
      totals.add(row, postOrderLocationLabel(order, input.postId), inNow);
      list.row(r, row, written - 1, { dim: !inNow });
      sheet.getRow(r).commit();
      r += 1;
    }
    const lastRow = r - 1;
    if (!written) {
      list.empty(r, "Pochtada buyurtma yo'q");
      sheet.getRow(r).commit();
      r += 1;
    }

    const nowLetter = list.letter('in_post_now');
    list.total(r, {
      products: {
        value: list.subtotal('n', firstRow, lastRow, written, 2),
        fmt: countFormat('ta buyurtma'),
        align: 'left',
      },
      in_post_now: {
        value: written
          ? formula(
              `COUNTIF(${nowLetter}${firstRow}:${nowLetter}${lastRow},"ha")`,
              inPostNow,
            )
          : 0,
        fmt: LIST_COUNT_FMT,
        align: 'center',
      },
      ...(hideMoney
        ? {}
        : {
            total_price: {
              value: list.subtotal(
                'total_price',
                firstRow,
                lastRow,
                totals.sum,
              ),
            },
          }),
    });
    sheet.getRow(r).commit();
    list.finish(headRow, firstRow, lastRow);
    sheet.commit();

    writePostSummary(workbook, totals, {
      postId: input.postId,
      subtitle: courier,
      hideMoney,
      historyIncomplete,
      now,
    });
    await workbook.commit();
    return { status: 'completed', written };
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    return { status: 'aborted', written, error };
  }
}
