/**
 * `GET /warehouses/:id/export` — ombor qoldig'i.
 *
 * 1-varaq «Xulosa»: nima tugagan / kam qolgan, marketlar bo'yicha; 2-varaq
 * «Qoldiq»: to'liq ro'yxat (Tugagan → Kam qoldi → Yetarli, ichida mavjud soni
 * o'sishi bo'yicha).
 */
import {
  REPORT_COLORS,
  REPORT_FMT,
  addBanner,
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
  ReportList,
  addAttention,
  addCards,
  addSlimKpis,
  countFormat,
  groupDigits,
  reportDateTime,
  type ReportListColumn,
} from '@app/report-kit/stream';
import type { Workbook } from 'exceljs';

export const WAREHOUSE_LEVEL_LABELS: Readonly<Record<string, string>> = {
  ok: 'Yetarli',
  low: 'Kam qoldi',
  out: 'Tugagan',
};

const LEVEL_TONES: Readonly<Record<string, ReportTone>> = {
  ok: 'success',
  low: 'warning',
  out: 'danger',
};
const LEVEL_ORDER: readonly string[] = ['out', 'low', 'ok'];
const levelRank = (level: string) => {
  const index = LEVEL_ORDER.indexOf(level);
  return index < 0 ? LEVEL_ORDER.length : index;
};

/** «Xulosa» dagi tugagan / kam qolgan qatorlar (qolgani — «Qoldiq» varag'ida). */
export const WAREHOUSE_ALERT_ROWS = 300;

/** catalog-service `warehouse stock` qatori. */
export interface WarehouseStockSource {
  product?: {
    name?: string | null;
    code?: {
      value?: string | null;
      kind?: string | null;
      format?: string | null;
    } | null;
    chargeable_weight_kg?: number | string | null;
    chargeable_basis?: string | null;
  } | null;
  market?: { id?: string | null; name?: string | null } | null;
  on_hand?: number;
  reserved?: number;
  available?: number;
  threshold?: number;
  level?: string;
  last_movement_at?: string | Date | null;
}

export type WarehouseStockRow = {
  n: number;
  product: string;
  code: string;
  code_kind: string;
  market: string;
  on_hand: number;
  reserved: number;
  available: number;
  threshold: number;
  level: string;
  level_label: string;
  weight: number | string;
  basis: string;
  last_movement_at: Date | null;
};

const levelTone = (row: { level?: unknown }): ReportTone | undefined =>
  typeof row.level === 'string' ? LEVEL_TONES[row.level] : undefined;

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const WAREHOUSE_STOCK_COLUMNS: readonly ReportListColumn[] = [
  {
    header: '№',
    key: 'n',
    width: 5.5,
    align: 'center',
    fmt: REPORT_FMT.int,
    color: REPORT_COLORS.muted,
  },
  { header: 'Mahsulot', key: 'product', width: 30, wrap: true, bold: true },
  { header: 'Kod', key: 'code', width: 16, fmt: REPORT_FMT.text },
  {
    header: 'Kod turi',
    key: 'code_kind',
    width: 26.5,
    color: REPORT_COLORS.muted,
  },
  { header: 'Market', key: 'market', width: 16.5 },
  { header: 'Qoldiq', key: 'on_hand', width: 10, fmt: REPORT_FMT.int },
  { header: 'Band', key: 'reserved', width: 9, fmt: REPORT_FMT.somDash },
  {
    header: 'Mavjud',
    key: 'available',
    width: 10,
    fmt: REPORT_FMT.som,
    bold: true,
    tint: true,
    tone: (row) => (row.level === 'ok' ? undefined : levelTone(row)),
  },
  {
    header: 'Chegara',
    key: 'threshold',
    width: 10,
    fmt: REPORT_FMT.int,
    color: REPORT_COLORS.muted,
  },
  {
    header: 'Holat',
    key: 'level_label',
    width: 14,
    badge: true,
    tone: levelTone,
  },
  { header: 'Hisob vazni, kg', key: 'weight', width: 11, fmt: '0.000' },
  {
    header: 'Hisob asosi',
    key: 'basis',
    width: 14.5,
    color: REPORT_COLORS.muted,
  },
  {
    header: 'Oxirgi harakat',
    key: 'last_movement_at',
    width: 17,
    fmt: REPORT_FMT.dateTime,
    color: REPORT_COLORS.muted,
  },
];

const weightOf = (value: unknown): number | string => {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n : typeof value === 'string' ? value : '';
};

/** Saralangan va raqamlangan qatorlar. */
export function toWarehouseStockRows(
  source: readonly WarehouseStockSource[],
): WarehouseStockRow[] {
  return source
    .map((row) => {
      const level = String(row.level ?? '');
      return {
        product: row.product?.name ?? '',
        code: row.product?.code?.value ?? '',
        code_kind:
          row.product?.code?.kind === 'barcode'
            ? `Zavod shtrix kodi (${row.product?.code?.format ?? ''})`
            : 'Elchi QR kodi',
        market: row.market?.name ?? row.market?.id ?? '',
        on_hand: num(row.on_hand),
        reserved: num(row.reserved),
        available: num(row.available),
        threshold: num(row.threshold),
        level,
        level_label: WAREHOUSE_LEVEL_LABELS[level] ?? level,
        weight: weightOf(row.product?.chargeable_weight_kg),
        basis:
          row.product?.chargeable_basis === 'volumetric' ? "hajm bo'yicha" : '',
        last_movement_at: toExcelDate(row.last_movement_at),
      };
    })
    .sort(
      (a, b) =>
        levelRank(a.level) - levelRank(b.level) ||
        a.available - b.available ||
        a.product.localeCompare(b.product),
    )
    .map((row, index) => ({ n: index + 1, ...row }));
}

export interface WarehouseStockXlsxInput {
  rows: readonly WarehouseStockSource[];
  warehouseName?: string | null;
  /** Filtrlar: market_id, holat (`low,out`), qidiruv. */
  filters?: { marketId?: string; level?: string; search?: string };
  /** Filtr bo'yicha jami (fayl chegarasidan oshsa — DIQQAT). */
  total?: number;
  now?: Date;
}

/** «Andijon» → «Andijon ombori» (nomida «ombor» bo'lsa — o'zicha). */
const warehouseTitle = (name: string | null | undefined): string => {
  const title = name?.trim() ?? '';
  return !title || /ombor|sklad|склад/i.test(title) ? title : `${title} ombori`;
};

/** «Andijon ombori · barcha market · barcha holat». */
const subtitleOf = (input: WarehouseStockXlsxInput): string => {
  const { marketId, level, search } = input.filters ?? {};
  const market = marketId
    ? (input.rows.find((row) => String(row.market?.id ?? '') === marketId)
        ?.market?.name ?? 'tanlangan market')
    : 'barcha market';
  const levels = (level ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => WAREHOUSE_LEVEL_LABELS[item] ?? item);
  return [
    warehouseTitle(input.warehouseName),
    market,
    levels.length ? levels.join(', ') : 'barcha holat',
    search?.trim() && `Qidiruv: ${search.trim().slice(0, 60)}`,
  ]
    .filter(Boolean)
    .join(' · ');
};

interface MarketStock {
  name: string;
  count: number;
  on_hand: number;
  reserved: number;
  available: number;
  out: number;
  low: number;
}

const marketStocks = (rows: readonly WarehouseStockRow[]): MarketStock[] => {
  const markets = new Map<string, MarketStock>();
  for (const row of rows) {
    const name = row.market || "Ko'rsatilmagan";
    const market = markets.get(name) ?? {
      name,
      count: 0,
      on_hand: 0,
      reserved: 0,
      available: 0,
      out: 0,
      low: 0,
    };
    market.count += 1;
    market.on_hand += row.on_hand;
    market.reserved += row.reserved;
    market.available += row.available;
    if (row.level === 'out') market.out += 1;
    if (row.level === 'low') market.low += 1;
    markets.set(name, market);
  }
  return [...markets.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.on_hand - a.on_hand ||
      a.name.localeCompare(b.name),
  );
};

interface Context {
  title: string;
  subtitle: string;
  now: Date;
  warning: string | null;
  counts: { out: number; low: number; ok: number };
  on_hand: number;
  reserved: number;
  available: number;
}

function writeSummary(
  workbook: Workbook,
  rows: readonly WarehouseStockRow[],
  ctx: Context,
): void {
  const sheet = addReportSheet(
    workbook,
    'Xulosa',
    [6, 14, 16, 16, 10, 10, 10, 14],
    { tab: REPORT_COLORS.action, footer: `${ctx.title} — xulosa` },
  );
  const [day, time] = reportDateTime(ctx.now).split(' ');
  let r = addBanner(sheet, {
    title: ctx.title,
    subtitle: ctx.subtitle,
    right: day,
    rightSub: `${time} da yuklandi`,
  });
  if (ctx.warning) {
    r = addAttention(sheet, r, ctx.warning);
    sheet.getRow(r).height = 8;
    r += 1;
  }
  r = addCards(sheet, r, [
    {
      label: 'Tugagan',
      value: ctx.counts.out,
      fmt: LIST_COUNT_FMT,
      tone: 'danger',
      sub: 'mavjud 0 dona',
    },
    {
      label: 'Kam qoldi',
      value: ctx.counts.low,
      fmt: LIST_COUNT_FMT,
      tone: 'warning',
      sub: 'mavjud chegaradan oshmaydi',
    },
    {
      label: 'Yetarli',
      value: ctx.counts.ok,
      fmt: LIST_COUNT_FMT,
      tone: 'success',
      sub: `${groupDigits(rows.length)} ta mahsulotdan`,
    },
  ]);
  r = addSlimKpis(sheet, r, [
    { label: 'Qoldiq, dona', value: ctx.on_hand, fmt: REPORT_FMT.int },
    { label: 'Band, dona', value: ctx.reserved, fmt: REPORT_FMT.int },
    {
      label: 'Mavjud, dona',
      value: ctx.available,
      fmt: REPORT_FMT.som,
      tone: 'action',
    },
  ]);

  const alerts = rows.filter((row) => row.level !== 'ok');
  const shown = alerts.slice(0, WAREHOUSE_ALERT_ROWS);
  r = addSection(
    sheet,
    r,
    'Tugagan va kam qolgan mahsulotlar',
    shown.length < alerts.length
      ? `birinchi ${shown.length} ta, jami ${groupDigits(alerts.length)} ta · «Qoldiq» varag'ida`
      : 'farq = mavjud − chegara',
  );
  const alertTable = addTable<WarehouseStockRow>(sheet, r, {
    rows: shown,
    empty: 'Hammasi yetarli',
    columns: [
      {
        header: '№',
        value: (row) => row.n,
        align: 'center',
        color: REPORT_COLORS.muted,
      },
      { header: 'Mahsulot', value: (row) => row.product, span: 2, bold: true },
      { header: 'Market', value: (row) => row.market },
      {
        header: 'Mavjud',
        value: (row) => row.available,
        fmt: REPORT_FMT.som,
        bold: true,
        tone: levelTone,
      },
      {
        header: 'Chegara',
        value: (row) => row.threshold,
        fmt: REPORT_FMT.int,
        color: REPORT_COLORS.muted,
      },
      {
        header: 'Farq',
        value: (row, k) =>
          formula(`F${k}-G${k}`, row.available - row.threshold),
        fmt: REPORT_FMT.som,
      },
      {
        header: 'Holat',
        value: (row) => row.level_label,
        badge: true,
        align: 'center',
        tone: levelTone,
      },
    ],
  });

  r = addSection(
    sheet,
    alertTable.next,
    "Marketlar bo'yicha",
    `${groupDigits(rows.length)} ta mahsulot`,
  );
  addTable(sheet, r, {
    total: true,
    rows: marketStocks(rows),
    columns: [
      { header: 'Market', value: (m) => m.name, span: 2, bold: true },
      {
        header: 'Mahsulotlar',
        value: (m) => m.count,
        fmt: REPORT_FMT.int,
        sum: true,
      },
      {
        header: 'Qoldiq, dona',
        value: (m) => m.on_hand,
        fmt: REPORT_FMT.int,
        sum: true,
      },
      {
        header: 'Band',
        value: (m) => m.reserved,
        fmt: REPORT_FMT.somDash,
        sum: true,
      },
      {
        header: 'Mavjud',
        value: (m) => m.available,
        fmt: REPORT_FMT.som,
        sum: true,
        bold: true,
      },
      {
        header: 'Tugagan',
        value: (m) => m.out,
        fmt: REPORT_FMT.somDash,
        sum: true,
        color: REPORT_COLORS.danger,
      },
      {
        header: 'Kam qoldi',
        value: (m) => m.low,
        fmt: REPORT_FMT.somDash,
        sum: true,
        color: REPORT_COLORS.warning,
      },
    ],
  });
}

function writeStock(
  workbook: Workbook,
  rows: readonly WarehouseStockRow[],
  ctx: Context,
): void {
  const headRow = ctx.warning ? 11 : 9;
  const sheet = addReportSheet(
    workbook,
    'Qoldiq',
    WAREHOUSE_STOCK_COLUMNS.map((column) => column.width),
    { orientation: 'landscape', freeze: headRow, footer: ctx.title },
  );
  let r = addBanner(sheet, {
    title: ctx.title,
    subtitle: ctx.subtitle,
    right: `${groupDigits(rows.length)} ta mahsulot`,
    rightSub: `${reportDateTime(ctx.now)} da yuklandi`,
  });
  if (ctx.warning) {
    r = addAttention(sheet, r, ctx.warning, 28);
    sheet.getRow(r).height = 6;
    r += 1;
  }
  r = addSlimKpis(sheet, r, [
    {
      label: 'Tugagan',
      value: ctx.counts.out,
      fmt: LIST_COUNT_FMT,
      tone: 'danger',
    },
    {
      label: 'Kam qoldi',
      value: ctx.counts.low,
      fmt: LIST_COUNT_FMT,
      tone: 'warning',
    },
    {
      label: 'Yetarli',
      value: ctx.counts.ok,
      fmt: LIST_COUNT_FMT,
      tone: 'success',
    },
    { label: 'Mavjud, dona', value: ctx.available, fmt: REPORT_FMT.som },
  ]);
  const list = new ReportList(sheet, WAREHOUSE_STOCK_COLUMNS);
  list.header(r, 28);
  r += 1;
  const first = r;
  rows.forEach((row, index) => {
    list.row(r, row, index);
    r += 1;
  });
  const last = r - 1;
  if (!rows.length) {
    list.empty(r, "Qoldiq yo'q");
    r += 1;
  }
  list.total(r, {
    product: {
      value: list.subtotal('n', first, last, rows.length, 2),
      fmt: countFormat('ta mahsulot'),
      align: 'left',
    },
    on_hand: { value: list.subtotal('on_hand', first, last, ctx.on_hand) },
    reserved: { value: list.subtotal('reserved', first, last, ctx.reserved) },
    available: {
      value: list.subtotal('available', first, last, ctx.available),
    },
  });
  list.finish(headRow, first, last);
}

export async function buildWarehouseStockXlsx(
  input: WarehouseStockXlsxInput,
): Promise<Buffer> {
  const rows = toWarehouseStockRows(input.rows);
  const count = (level: string) =>
    rows.reduce((sum, row) => sum + (row.level === level ? 1 : 0), 0);
  const sum = (key: 'on_hand' | 'reserved' | 'available') =>
    rows.reduce((total, row) => total + row[key], 0);
  const total = Number(input.total ?? rows.length) || rows.length;
  const now = input.now ?? new Date();
  const ctx: Context = {
    title: "Ombor qoldig'i",
    subtitle: subtitleOf(input),
    now,
    warning:
      total > rows.length
        ? `DIQQAT: faylda birinchi ${groupDigits(rows.length)} ta mahsulot — filtr bo'yicha jami ${groupDigits(total)} ta. Market, holat yoki qidiruv bilan toraytirib, qismlab yuklab oling.`
        : null,
    counts: { out: count('out'), low: count('low'), ok: count('ok') },
    on_hand: sum('on_hand'),
    reserved: sum('reserved'),
    available: sum('available'),
  };
  const workbook = createReport(ctx.title, now);
  writeSummary(workbook, rows, ctx);
  writeStock(workbook, rows, ctx);
  return reportToBuffer(workbook);
}
