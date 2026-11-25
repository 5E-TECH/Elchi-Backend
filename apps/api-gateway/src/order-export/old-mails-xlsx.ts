/**
 * `POST /export/old-mails.xlsx` — «Eski pochtalar hisoboti» (va «Filial
 * paketlari» rejimi). SOF RENDER: qatorlarni sahifaning o'zi (o'z doirasi
 * bilan) beradi — server ularni bazadan o'qimaydi, faqat .xlsx qiladi.
 */
import {
  REPORT_COLORS,
  REPORT_FMT,
  addBanner,
  addDataBars,
  addReportSheet,
  addSection,
  addTable,
  createReport,
  formula,
  reportToBuffer,
  toExcelDate,
  type ReportTone,
} from '@app/report-kit';
import {
  LIST_COUNT_FMT,
  LIST_ID_FMT,
  ReportList,
  addAttention,
  addCards,
  addSlimKpis,
  alignBadge,
  countFormat,
  groupDigits,
  reportDateTime,
  type ReportListColumn,
} from '@app/report-kit/stream';
import type { Workbook } from 'exceljs';
import {
  OLD_MAILS_DEFAULT_LABELS,
  OLD_MAILS_STATUS_TONES,
  OLD_PACKETS_DEFAULT_LABELS,
  type OldMailsExportRequestDto,
} from '../dto/old-mails-export.swagger.dto';
import { formatTashkentDateTime } from './orders-xlsx.export';

type Labels = Record<keyof typeof OLD_MAILS_DEFAULT_LABELS, string>;

type Row = {
  n: number;
  id: number | string;
  region: string;
  courier: string;
  status: string;
  tone: ReportTone | undefined;
  orders: number;
  amount: number;
  created_at: Date | string;
};

interface Group {
  name: string;
  tone?: ReportTone;
  count: number;
  orders: number;
  amount: number;
}

/** «Xulosa» jadvalidagi eng ko'p guruh (qolgani «Boshqalar»). */
const SUMMARY_TOP = 100;
/** Holat kartalari soni. */
const STATUS_CARDS = 4;
const TONE_ORDER: ReadonlyArray<ReportTone | undefined> = [
  'success',
  'info',
  'warning',
  'danger',
  'neutral',
  undefined,
];

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toneOf = (value: unknown): ReportTone | undefined =>
  (OLD_MAILS_STATUS_TONES as readonly unknown[]).includes(value)
    ? (value as ReportTone)
    : undefined;

const toRow = (
  row: OldMailsExportRequestDto['rows'][number],
  index: number,
): Row => {
  const id = text(row.id);
  return {
    n: index + 1,
    id:
      /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
        ? Number(id)
        : id,
    region: text(row.region),
    courier: text(row.courier),
    status: text(row.status),
    tone: toneOf(row.status_tone),
    orders: num(row.orders),
    amount: num(row.amount),
    created_at: toExcelDate(row.created_at) ?? text(row.created_at),
  };
};

const labelsOf = (input: OldMailsExportRequestDto): Labels => {
  const labels: Labels = {
    ...OLD_MAILS_DEFAULT_LABELS,
    ...(input.hide_courier ? OLD_PACKETS_DEFAULT_LABELS : {}),
  };
  for (const key of Object.keys(labels) as Array<keyof Labels>) {
    const value = text(input.labels?.[key]);
    if (value) labels[key] = value;
  }
  return labels;
};

const columnsOf = (
  labels: Labels,
  hideCourier: boolean,
): ReportListColumn[] => [
  {
    header: labels.no,
    key: 'n',
    width: 6,
    align: 'center',
    fmt: REPORT_FMT.int,
    color: REPORT_COLORS.muted,
  },
  {
    header: labels.mail_id,
    key: 'id',
    width: 11,
    fmt: LIST_ID_FMT,
    align: 'left',
    bold: true,
  },
  { header: labels.region, key: 'region', width: 18 },
  ...(hideCourier
    ? []
    : [{ header: labels.courier, key: 'courier', width: 17 }]),
  {
    header: labels.status,
    key: 'status',
    width: 17,
    badge: true,
    tone: (row) => row.tone as ReportTone | undefined,
  },
  {
    header: labels.orders,
    key: 'orders',
    width: 12.5,
    fmt: REPORT_FMT.int,
  },
  {
    header: `${labels.amount}, ${labels.currency}`,
    key: 'amount',
    width: 16,
    fmt: REPORT_FMT.som,
    bold: true,
  },
  {
    header: labels.date,
    key: 'created_at',
    width: 17,
    fmt: REPORT_FMT.dateTime,
    color: REPORT_COLORS.muted,
  },
];

const groupRows = (
  rows: readonly Row[],
  nameOf: (row: Row) => string,
  others: string,
  compare?: (a: Group, b: Group) => number,
): Group[] => {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const name = nameOf(row);
    const group = groups.get(name) ?? { name, count: 0, orders: 0, amount: 0 };
    group.tone ??= row.tone;
    group.count += 1;
    group.orders += row.orders;
    group.amount += row.amount;
    groups.set(name, group);
  }
  const list = [...groups.values()].sort(
    (a, b) =>
      compare?.(a, b) ||
      b.count - a.count ||
      b.amount - a.amount ||
      a.name.localeCompare(b.name),
  );
  if (list.length <= SUMMARY_TOP) return list;
  const rest = list.slice(SUMMARY_TOP);
  const sum = (key: 'count' | 'orders' | 'amount') =>
    rest.reduce((total, group) => total + group[key], 0);
  return [
    ...list.slice(0, SUMMARY_TOP),
    {
      name: `${others} (${rest.length})`,
      count: sum('count'),
      orders: sum('orders'),
      amount: sum('amount'),
    },
  ];
};

interface Context {
  title: string;
  subtitle: string;
  labels: Labels;
  hideCourier: boolean;
  warning: string | null;
  now: Date;
  orders: number;
  amount: number;
}

function writeGroups(
  ws: ReturnType<typeof addReportSheet>,
  start: number,
  ctx: Context,
  o: { title: string; head: string; rows: Group[]; badge?: boolean },
): number {
  const r = addSection(ws, start, o.title);
  const first = r + 1;
  const total = first + o.rows.length;
  const table = addTable<Group>(ws, r, {
    rows: o.rows,
    total: true,
    totalLabel: ctx.labels.total,
    empty: '—',
    columns: [
      {
        header: o.head,
        value: (group) => group.name,
        span: 2,
        align: 'left',
        bold: !o.badge,
        ...(o.badge ? { badge: true, tone: (group) => group.tone } : {}),
      },
      {
        header: ctx.labels.mails,
        value: (group) => group.count,
        fmt: REPORT_FMT.int,
        sum: true,
        bold: true,
      },
      {
        header: ctx.labels.orders,
        value: (group) => group.orders,
        fmt: REPORT_FMT.int,
        sum: true,
      },
      {
        header: ctx.labels.share,
        value: (group, k) =>
          formula(
            `IF(G$${total}=0,0,G${k}/G$${total})`,
            ctx.amount ? group.amount / ctx.amount : 0,
          ),
        fmt: REPORT_FMT.pct,
        totalValue: formula(`SUM(F${first}:F${total - 1})`, ctx.amount ? 1 : 0),
      },
      {
        header: `${ctx.labels.amount}, ${ctx.labels.currency}`,
        value: (group) => group.amount,
        fmt: REPORT_FMT.som,
        sum: true,
        bold: true,
      },
    ],
  });
  if (o.rows.length) {
    if (o.badge) {
      for (let k = table.first; k <= table.last; k += 1) {
        alignBadge(ws.getCell(k, 2));
      }
    }
    addDataBars(ws, `G${table.first}:G${table.last}`);
  }
  return table.next;
}

function writeSummary(
  workbook: Workbook,
  rows: readonly Row[],
  ctx: Context,
): void {
  const { labels } = ctx;
  const ws = addReportSheet(workbook, 'Xulosa', [21, 7, 14, 14, 10, 18], {
    tab: REPORT_COLORS.action,
    footer: `${ctx.title} — xulosa`,
  });
  let r = addBanner(ws, {
    title: labels.summary_title,
    subtitle: ctx.subtitle,
    right: `${groupDigits(rows.length)} ta`,
    rightSub: reportDateTime(ctx.now),
  });
  if (ctx.warning) {
    r = addAttention(ws, r, ctx.warning);
    ws.getRow(r).height = 8;
    r += 1;
  }
  const rank = (group: Group) => TONE_ORDER.indexOf(group.tone);
  const statuses = groupRows(
    rows,
    (row) => row.status || '—',
    labels.others,
    (a, b) => rank(a) - rank(b),
  );
  const cards = statuses.slice(0, STATUS_CARDS);
  if (cards.length) {
    r = addCards(
      ws,
      r,
      cards.map((group) => ({
        label: group.name,
        value: group.count,
        fmt: LIST_COUNT_FMT,
        tone: group.tone,
        sub: `${groupDigits(group.orders)} ${labels.orders_unit}`,
      })),
    );
  }
  r = writeGroups(ws, r, ctx, {
    title: labels.by_status,
    head: labels.status,
    rows: statuses,
    badge: true,
  });
  r = writeGroups(ws, r, ctx, {
    title: labels.by_region,
    head: labels.region,
    rows: groupRows(rows, (row) => row.region || '—', labels.others),
  });
  if (!ctx.hideCourier) {
    writeGroups(ws, r, ctx, {
      title: labels.by_courier,
      head: labels.courier,
      rows: groupRows(
        rows,
        (row) => row.courier || labels.unassigned,
        labels.others,
      ),
    });
  }
}

function writeList(
  workbook: Workbook,
  rows: readonly Row[],
  ctx: Context,
): void {
  const { labels } = ctx;
  const columns = columnsOf(labels, ctx.hideCourier);
  const headRow = ctx.warning ? 11 : 9;
  const ws = addReportSheet(
    workbook,
    ctx.hideCourier ? 'Eski paketlar' : 'Eski pochtalar',
    columns.map((column) => column.width),
    { freeze: headRow, footer: ctx.title },
  );
  let r = addBanner(ws, {
    title: ctx.title,
    subtitle: ctx.subtitle,
    right: `${groupDigits(rows.length)} ${labels.mails_unit}`,
    rightSub: `${labels.generated_at}: ${reportDateTime(ctx.now)}`,
  });
  if (ctx.warning) {
    r = addAttention(ws, r, ctx.warning);
    ws.getRow(r).height = 6;
    r += 1;
  }
  r = addSlimKpis(ws, r, [
    { label: labels.total_mails, value: rows.length, fmt: LIST_COUNT_FMT },
    { label: labels.total_orders, value: ctx.orders, fmt: LIST_COUNT_FMT },
    {
      label: `${labels.total_amount}, ${labels.currency}`,
      value: ctx.amount,
      tone: 'action',
    },
  ]);
  const list = new ReportList(ws, columns);
  list.header(r, 28);
  r += 1;
  const first = r;
  rows.forEach((row, index) => {
    list.row(r, row, index);
    r += 1;
  });
  const last = r - 1;
  if (!rows.length) {
    list.empty(r, '—');
    r += 1;
  }
  list.total(
    r,
    {
      region: {
        value: list.subtotal('n', first, last, rows.length, 2),
        fmt: countFormat(labels.mails_unit),
        align: 'left',
      },
      orders: { value: list.subtotal('orders', first, last, ctx.orders) },
      amount: { value: list.subtotal('amount', first, last, ctx.amount) },
    },
    labels.total,
  );
  r += 1;
  if (ctx.warning) {
    ws.getRow(r).height = 8;
    addAttention(ws, r + 1, ctx.warning, 28);
  }
  list.finish(headRow, first, last);
}

/** `old-mails-<YYYY-MM-DD>.xlsx` (Toshkent kuni). */
export const oldMailsXlsxFileName = (now: Date = new Date()): string =>
  `old-mails-${formatTashkentDateTime(now).slice(0, 10)}.xlsx`;

export async function buildOldMailsXlsx(
  input: OldMailsExportRequestDto,
  now: Date = new Date(),
): Promise<Buffer> {
  const rows = input.rows.map(toRow);
  const labels = labelsOf(input);
  const ctx: Context = {
    title: input.title,
    subtitle: input.subtitle ?? '',
    labels,
    hideCourier: Boolean(input.hide_courier),
    warning: input.capped
      ? text(input.labels?.capped_note) ||
        `DIQQAT: fayl to'liq emas — faqat birinchi ${groupDigits(rows.length)} qator. Filtrni toraytirib, qismlab yuklab oling.`
      : null,
    now,
    orders: rows.reduce((sum, row) => sum + row.orders, 0),
    amount: rows.reduce((sum, row) => sum + row.amount, 0),
  };
  const workbook = createReport(ctx.title, now);
  writeList(workbook, rows, ctx);
  writeSummary(workbook, rows, ctx);
  return reportToBuffer(workbook);
}
