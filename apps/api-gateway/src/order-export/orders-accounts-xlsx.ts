/**
 * `GET /export/orders.xlsx` — buyurtmalar eksporti HISOB ko'rsatkichlari bilan
 * (jami narx, marketga to'lanishi kerak / to'langan / qoldi).
 *
 * Jami tepada bo'lgani uchun qatorlar xotirada, lekin IXCHAM ko'rinishda
 * (`toOrdersAccountsRow` — order-service'ning to'liq boyitilgan qatori emas).
 * Katta ro'yxat (`ORDERS_ACCOUNTS_STREAM_FROM` dan ko'p) oqimli yozuvchi bilan
 * chiqadi: kataklar xotirada to'planmaydi, logotip o'rniga «ELCHI POCHTA»
 * yozuvi.
 */
import {
  REPORT_COLORS,
  REPORT_FMT,
  addReportSheet,
  addSection,
  addTable,
  formula,
  type ReportColumn,
} from '@app/report-kit';
import {
  LIST_ID_FMT,
  ReportList,
  ReportTally,
  addAttention,
  addCards,
  addShareTable,
  addSlimKpis,
  countFormat,
  openReportBook,
  reportDateTime,
  type ReportBook,
  type ReportListColumn,
} from '@app/report-kit/stream';
import {
  ORDER_EXPORT_CANCELLED_LABELS,
  ORDER_EXPORT_SOLD_LABELS,
  ORDER_EXPORT_STATUS_ORDER,
  ORDER_EXPORT_UNKNOWN_STATUS_LABEL,
  formatCount,
  orderExportDate,
  orderExportId,
  orderExportLimitWarning,
  orderExportPhone,
  orderExportShrunkWarning,
  orderExportStatusLabel,
  orderExportStatusTone,
} from './orders-xlsx.export';

type Obj = Record<string, unknown>;

/** Shundan ko'p qatorda — oqimli yozuvchi (xotira). */
export const ORDERS_ACCOUNTS_STREAM_FROM = 10_000;

/** `type` (interface emas) — `ReportList` ning indeksli qatoriga mos. */
export type OrdersAccountsRow = {
  n: number;
  id: number | string;
  market: string;
  customer: string;
  phone: string;
  region: string;
  district: string;
  address: string;
  total_price: number;
  paid_amount: number;
  to_be_paid: number;
  status: string;
  created_at: Date | string;
  courier: string;
};

export const ORDERS_ACCOUNTS_COLUMNS: readonly ReportListColumn[] = [
  {
    header: '№',
    key: 'n',
    width: 5.5,
    align: 'center',
    fmt: REPORT_FMT.int,
    color: REPORT_COLORS.muted,
  },
  {
    header: 'ID',
    key: 'id',
    width: 9,
    fmt: LIST_ID_FMT,
    align: 'left',
    bold: true,
  },
  { header: 'Market', key: 'market', width: 16 },
  { header: 'Mijoz', key: 'customer', width: 17 },
  { header: 'Telefon', key: 'phone', width: 18 },
  { header: 'Viloyat', key: 'region', width: 17.5 },
  { header: 'Tuman', key: 'district', width: 13 },
  { header: 'Manzil', key: 'address', width: 29, wrap: true },
  {
    header: "Jami narx, so'm",
    key: 'total_price',
    width: 14,
    fmt: REPORT_FMT.som,
    bold: true,
  },
  {
    header: "To'langan, so'm",
    key: 'paid_amount',
    width: 14,
    fmt: REPORT_FMT.somDash,
    color: REPORT_COLORS.success,
  },
  {
    header: "To'lanishi kerak, so'm",
    key: 'to_be_paid',
    width: 15,
    fmt: REPORT_FMT.somDash,
  },
  {
    header: 'Holati',
    key: 'status',
    width: 20,
    badge: true,
    tone: (row) => orderExportStatusTone(row.status),
  },
  {
    header: 'Sana',
    key: 'created_at',
    width: 17,
    fmt: REPORT_FMT.dateTime,
    color: REPORT_COLORS.muted,
  },
  { header: 'Kuryer', key: 'courier', width: 16.5 },
];

const obj = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {};

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

/**
 * Kuryer ismi order-service qatoridan (`courier: {id, name}` — alohida RPC
 * kerak emas); ism olinmagan bo'lsa — `#<id>`, kuryer yo'q bo'lsa — bo'sh.
 */
const courierName = (order: Obj): string => {
  const courier = obj(order.courier);
  const name = text(courier.name, courier.full_name, order.courier_name);
  if (name) return name;
  const id = text(order.courier_id);
  return id && id !== '0' ? `#${id}` : '';
};

/** Boyitilgan buyurtma → ixcham eksport qatori. */
export function toOrdersAccountsRow(order: Obj, n: number): OrdersAccountsRow {
  const customer = obj(order.customer);
  return {
    n,
    id: orderExportId(order.id),
    market: text(obj(order.market).name),
    customer: text(customer.name),
    phone: orderExportPhone(customer.phone_number),
    region: text(obj(order.region).name, obj(customer.region).name),
    district: text(obj(order.district).name, obj(customer.district).name),
    address: text(order.address),
    total_price: money(order.total_price),
    paid_amount: money(order.paid_amount),
    to_be_paid: money(order.to_be_paid),
    status: orderExportStatusLabel(order),
    created_at: orderExportDate(order.createdAt),
    courier: courierName(order),
  };
}

export interface OrdersAccountsInput {
  rows: OrdersAccountsRow[];
  /** Filtr bo'yicha jami (order-service `total`). */
  total: number;
  maxRows: number;
  subtitle: string;
  /**
   * Marketga «to'langan / kerak / qoldi» (market tarifini ochadi) — faqat
   * superadmin/admin. `false` (menejer, filial, registrator — D5NxxpJW):
   * ustunlar, ko'rsatkichlar va «Marketlar bilan hisob» pulisiz.
   */
  marketMoney?: boolean;
  now?: Date;
  /** Sinov uchun: oqimli yozuvchiga o'tish chegarasi. */
  streamFrom?: number;
}

interface MarketAccount {
  name: string;
  count: number;
  price: number;
  due: number;
  paid: number;
}

const marketAccounts = (rows: readonly OrdersAccountsRow[]) => {
  const accounts = new Map<string, MarketAccount>();
  for (const row of rows) {
    const name = row.market || "Ko'rsatilmagan";
    const account = accounts.get(name) ?? {
      name,
      count: 0,
      price: 0,
      due: 0,
      paid: 0,
    };
    account.count += 1;
    account.price += row.total_price;
    account.due += row.to_be_paid;
    account.paid += row.paid_amount;
    accounts.set(name, account);
  }
  return [...accounts.values()].sort(
    (a, b) =>
      b.count - a.count || b.price - a.price || a.name.localeCompare(b.name),
  );
};

/** «Kerak / To'langan / Qoldi» — faqat superadmin/admin faylida (D5NxxpJW). */
const marketMoneyColumns = (): ReportColumn<MarketAccount>[] => [
  {
    header: "Kerak, so'm",
    value: (m) => m.due,
    fmt: REPORT_FMT.somDash,
    sum: true,
  },
  {
    header: "To'langan, so'm",
    value: (m) => m.paid,
    fmt: REPORT_FMT.somDash,
    sum: true,
    color: REPORT_COLORS.success,
  },
  {
    header: "Qoldi, so'm",
    value: (m, k) => formula(`F${k}-G${k}`, m.due - m.paid),
    fmt: REPORT_FMT.somDash,
    bold: true,
    sum: true,
  },
];

/** Market tarifini ochadigan ustunlar (D5NxxpJW). */
const MARKET_MONEY_KEYS: ReadonlySet<string> = new Set([
  'paid_amount',
  'to_be_paid',
]);

function writeSummary(
  book: ReportBook,
  rows: readonly OrdersAccountsRow[],
  o: {
    subtitle: string;
    now: Date;
    warnings: readonly string[];
    price: number;
    due: number;
    paid: number;
    marketMoney: boolean;
  },
): void {
  const count = formatCount(rows.length);
  const statuses = new ReportTally(ORDER_EXPORT_UNKNOWN_STATUS_LABEL);
  const regions = new ReportTally();
  for (const row of rows) {
    statuses.add(row.status, row.total_price);
    regions.add(row.region, row.total_price);
  }
  const sold = statuses.total(ORDER_EXPORT_SOLD_LABELS);
  const cancelled = statuses.total(ORDER_EXPORT_CANCELLED_LABELS);

  const sheet = addReportSheet(
    book.workbook,
    'Xulosa',
    [13, 12, 9.5, 14, 14, 14.5, 14.5],
    { tab: REPORT_COLORS.action, footer: 'Buyurtmalar — xulosa' },
  );
  let r = book.banner(sheet, {
    title: 'Buyurtmalar xulosasi',
    subtitle: o.subtitle,
    right: `${count} ta`,
    rightSub: reportDateTime(o.now),
  });
  for (const warning of o.warnings) {
    r = addAttention(sheet, r, warning, 46);
    sheet.getRow(r).height = 8;
    r += 1;
  }
  r = addCards(sheet, r, [
    { label: "Jami narx, so'm", value: o.price, sub: `${count} ta buyurtma` },
    {
      label: "Sotilgan, so'm",
      value: sold.sum,
      tone: 'success',
      sub: `${formatCount(sold.count)} ta`,
    },
    {
      label: "Bekor va qaytgan, so'm",
      value: cancelled.sum,
      tone: 'danger',
      sub: `${formatCount(cancelled.count)} ta`,
    },
  ]);
  const spans = [2, 1, 1, 2, 1] as const;
  r = addShareTable(sheet, r, {
    title: "Holatlar bo'yicha",
    note: `${count} ta buyurtma`,
    head: 'Holati',
    rows: statuses.list({
      order: ORDER_EXPORT_STATUS_ORDER,
      tone: orderExportStatusTone,
    }),
    badge: true,
    spans,
    sumHead: "Jami narx, so'm",
  });

  r = addSection(
    sheet,
    r,
    o.marketMoney ? 'Marketlar bilan hisob' : "Marketlar bo'yicha",
    o.marketMoney ? "to'lanishi kerak − to'langan = qoldi" : undefined,
  );
  const table = addTable(sheet, r, {
    total: true,
    rows: marketAccounts(rows),
    columns: [
      { header: 'Market', value: (m) => m.name, bold: true, span: 2 },
      {
        header: 'Soni',
        value: (m) => m.count,
        fmt: REPORT_FMT.int,
        sum: true,
      },
      {
        header: "Jami narx, so'm",
        value: (m) => m.price,
        fmt: REPORT_FMT.som,
        sum: true,
      },
      ...(o.marketMoney ? marketMoneyColumns() : []),
    ],
  });
  addShareTable(sheet, table.next, {
    title: "Viloyatlar bo'yicha",
    head: 'Viloyat',
    rows: regions.list(),
    spans,
    sumHead: "Jami narx, so'm",
  });
  book.commitSheet(sheet);
}

export async function buildOrdersAccountsXlsx(
  input: OrdersAccountsInput,
): Promise<Buffer> {
  const { rows, total, maxRows, subtitle } = input;
  const now = input.now ?? new Date();
  const marketMoney = input.marketMoney ?? true;
  const columns = marketMoney
    ? ORDERS_ACCOUNTS_COLUMNS
    : ORDERS_ACCOUNTS_COLUMNS.filter(
        (column) => !MARKET_MONEY_KEYS.has(column.key),
      );
  const count = rows.length;
  const truncated = total > maxRows;
  // Ilgari chegaradan oshgan qism JIMGINA qirqilardi.
  const warnings = truncated
    ? [orderExportLimitWarning(maxRows, total, count)]
    : count < total
      ? [orderExportShrunkWarning(total, count)]
      : [];
  let price = 0;
  let due = 0;
  let paid = 0;
  for (const row of rows) {
    price += row.total_price;
    due += row.to_be_paid;
    paid += row.paid_amount;
  }

  const book = openReportBook('Buyurtmalar eksporti', {
    now,
    streamed: count > (input.streamFrom ?? ORDERS_ACCOUNTS_STREAM_FROM),
  });
  const headRow = 9 + warnings.length * 2;
  const sheet = addReportSheet(
    book.workbook,
    'Buyurtmalar',
    columns.map((column) => column.width),
    {
      orientation: 'landscape',
      freeze: headRow,
      freezeColumns: 3,
      footer: 'Buyurtmalar eksporti',
    },
  );
  let r = book.banner(sheet, {
    title: 'Buyurtmalar eksporti',
    subtitle,
    right: `${formatCount(count)} ta buyurtma`,
    rightSub: truncated
      ? `filtr bo'yicha jami ${formatCount(total)} ta`
      : `${reportDateTime(now)} da yuklandi`,
  });
  for (const warning of warnings) {
    r = addAttention(sheet, r, warning);
    sheet.getRow(r).height = 6;
    r += 1;
  }
  r = addSlimKpis(sheet, r, [
    { label: "Jami narx, so'm", value: price },
    ...(marketMoney
      ? ([
          { label: "Marketga to'lanishi kerak, so'm", value: due },
          { label: "Marketga to'langan, so'm", value: paid, tone: 'success' },
          {
            label: "Qoldi, so'm",
            value: due - paid,
            tone: due - paid ? 'warning' : 'success',
          },
        ] as const)
      : []),
  ]);
  const list = new ReportList(sheet, columns);
  list.header(r, 28);
  book.commitRow(sheet, r);
  r += 1;
  const firstRow = r;
  rows.forEach((row, index) => {
    list.row(r, row, index);
    book.commitRow(sheet, r);
    r += 1;
  });
  const lastRow = r - 1;
  if (!count) {
    list.empty(r, 'Buyurtma topilmadi');
    r += 1;
  }
  list.total(r, {
    address: {
      value: list.subtotal('n', firstRow, lastRow, count, 2),
      fmt: countFormat('ta buyurtma'),
      align: 'left',
    },
    total_price: {
      value: list.subtotal('total_price', firstRow, lastRow, price),
    },
    ...(marketMoney
      ? {
          paid_amount: {
            value: list.subtotal('paid_amount', firstRow, lastRow, paid),
          },
          to_be_paid: {
            value: list.subtotal('to_be_paid', firstRow, lastRow, due),
          },
        }
      : {}),
  });
  r += 1;
  for (const warning of warnings) {
    sheet.getRow(r).height = 8;
    r = addAttention(sheet, r + 1, warning, 28);
  }
  list.finish(headRow, firstRow, lastRow);
  book.commitSheet(sheet);

  writeSummary(book, rows, {
    subtitle,
    now,
    warnings,
    price,
    due,
    paid,
    marketMoney,
  });
  return book.finish();
}
