import { Writable } from 'node:stream';
import {
  stream as excelStream,
  type CellFormulaValue,
  type CellValue,
  type Style,
  type Workbook,
  type Worksheet,
} from 'exceljs';
import {
  REPORT_COLORS as C,
  REPORT_FMT,
  REPORT_TONES,
  addBanner,
  addKpis,
  addReportSheet,
  addSection,
  addTable,
  columnLetter,
  createReport,
  eachCell,
  edge,
  formula,
  reportFont,
  reportToBuffer,
  solid,
  type ReportTone,
} from '@app/report-kit';
import type { CampaignReportKind } from './campaign-report-export.entity';
import {
  BUCKET_LABELS,
  channelLabel,
  reasonLabel,
  roleLabel,
  statusBucket,
  statusLabel,
  type UndeliveredBucket,
} from './campaign-report.labels';
import type { UndeliveredItem } from './campaign-report.service';
import { toTashkentIso } from './campaign-schedule';

/**
 * C7 — kampaniya «Yetkazilmaganlar» hisoboti (.xlsx, ega tasdiqlagan dizayn):
 * «Xulosa» (sabab / kanal / rol kesimi) va «Yetkazilmaganlar» (bitta qator =
 * bitta qabul qiluvchi, bir nechta kanal — katakda alohida satrda). Telefon
 * faqat maskalangan; matn har doim matn (`=` bilan boshlansa ham).
 *
 * Xotira: qatorlar ixcham saqlanadi (kanal/holat/sabab birikmasi va rol —
 * umumiy obyekt). `IN_MEMORY_MAX_ROWS` gacha oddiy ish kitobi (logotip bilan;
 * o'lchov: 10 000 qator — +150 MB, 0,3 s); kattasi — oqimli yozuvchi: qator
 * yozilishi bilan xotiradan chiqadi (100 000 qator — +90 MB, 1,2 s, voqea
 * tsikli ≤ 30 ms band; oddiy yozuvda ~1,5 GB bo'lardi — konteyner 1 GB).
 * Oqimli yozuvchi rasm qo'ya olmaydi — logotip o'rnida «ELCHI POCHTA» yozuvi.
 */

/** Shundan katta fayl oqimli yoziladi. */
export const IN_MEMORY_MAX_ROWS = 10_000;
/** Oqimda shuncha qatordan keyin siqish navbati bo'shashi kutiladi. */
const FLUSH_ROWS = 250;
/** Sabablar kesimi: ko'pi bilan shuncha qator, qolgani — «Boshqalar». */
const REASONS_MAX = 20;
/** Bitta katak matni (Excel chegarasi 32 767). */
const TEXT_MAX = 1000;
/** Excel qator balandligi chegarasi — 409 pt. */
const ROW_HEIGHT_MAX = 400;

const TITLE = 'Kampaniya — yetkazilmaganlar';
const BLANK = '—';
const NOT_SET = "Ko'rsatilmagan";
const COUNT_FMT = '#,##0" ta"';
const PERSON_FMT = '#,##0" kishi"';
const ID_FMT = '0';
const HEADER_ROW = 9;

const BUCKETS: readonly UndeliveredBucket[] = [
  'failed',
  'skipped',
  'no_provider',
];
const BUCKET_TONES: Readonly<Record<UndeliveredBucket, ReportTone>> = {
  failed: 'danger',
  skipped: 'neutral',
  no_provider: 'warning',
};

/** 12345 → «12 345». */
const grouped = (value: number): string =>
  String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** XML'ga sig'maydigan belgilar olinadi, juda uzun matn qisqaradi. */
const clean = (value: string | null | undefined): string => {
  const text = (value ?? '').replace(/[￾￿]/g, '').trim();
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
};

/** Raqamli ID — son; 15 xonadan uzuni Excel'da aniqligini yo'qotadi — matn. */
const idValue = (id: string): number | string =>
  /^\d{1,15}$/.test(id) ? Number(id) : clean(id);

/** Matn necha satrga sig'adi (Arial 10). */
const lineCount = (text: string, width: number): number => {
  const perLine = Math.max(4, (width * 7 - 12) / 5.85);
  let count = 0;
  for (const paragraph of text.split('\n')) {
    let used = 0;
    count += 1;
    for (const word of paragraph.split(' ')) {
      if (used && used + 1 + word.length > perLine) {
        count += 1;
        used = word.length;
      } else {
        used += (used ? 1 : 0) + word.length;
      }
      // Bo'shliqsiz uzun matn ham satrlarga bo'linadi.
      while (used > perLine) {
        count += 1;
        used -= perLine;
      }
    }
  }
  return count;
};

interface FailureLabels {
  channel: string;
  status: string;
  reason: string;
  bucket: UndeliveredBucket;
}

/** Bitta qabul qiluvchidagi xatolar birikmasi — qatorlar orasida umumiy. */
interface FailureSet {
  failures: FailureLabels[];
  channel: string;
  status: CellValue;
  reason: string;
  /** Holat katagi rangi; har xil bo'lsa — `undefined` (oddiy matn). */
  tone: ReportTone | undefined;
  height: number;
  count: number;
}

interface ReportRow {
  recipientId: string | null;
  name: string;
  role: string;
  phone: string;
  refId: string;
  set: FailureSet;
}

interface ListColumn {
  header: string;
  width: number;
  value: (row: ReportRow, index: number) => CellValue;
  fmt?: string;
  align?: 'left' | 'center';
  bold?: boolean;
  color?: string;
  wrap?: boolean;
  /** Katak rangi qatordagi holatdan. */
  status?: boolean;
}

const CHANNEL_WIDTH = 11;
const STATUS_WIDTH = 23;
const REASON_WIDTH = 30;
const COLUMNS: readonly ListColumn[] = [
  {
    header: '№',
    width: 5.5,
    value: (_row, index) => index + 1,
    fmt: REPORT_FMT.int,
    align: 'center',
    color: C.muted,
  },
  {
    header: 'Qabul qiluvchi ID',
    width: 12,
    value: (row) => (row.recipientId ? idValue(row.recipientId) : ''),
    fmt: ID_FMT,
  },
  {
    header: 'Ism',
    width: 18,
    value: (row) => row.name,
    fmt: REPORT_FMT.text,
    bold: true,
  },
  {
    header: 'Rol',
    width: 12,
    value: (row) => row.role,
    fmt: REPORT_FMT.text,
  },
  {
    header: 'Telefon',
    width: 11,
    value: (row) => row.phone,
    fmt: REPORT_FMT.text,
    color: C.muted,
  },
  {
    header: 'Kanal',
    width: CHANNEL_WIDTH,
    value: (row) => row.set.channel,
    fmt: REPORT_FMT.text,
    wrap: true,
  },
  {
    header: 'Holat',
    width: STATUS_WIDTH,
    value: (row) => row.set.status,
    fmt: REPORT_FMT.text,
    wrap: true,
    status: true,
  },
  {
    header: 'Sabab',
    width: REASON_WIDTH,
    value: (row) => row.set.reason,
    fmt: REPORT_FMT.text,
    wrap: true,
  },
  {
    header: 'Xabar ID',
    width: 11,
    value: (row) => idValue(row.refId),
    fmt: ID_FMT,
    color: C.muted,
  },
];
const FIRST_COLUMN = 2;
const LAST_COLUMN = FIRST_COLUMN + COLUMNS.length - 1;
const NUMBER_COLUMN = columnLetter(FIRST_COLUMN);
/** Ko'rsatkichlar qatori bo'laklari (kengligi deyarli teng). */
const KPI_SPANS: ReadonlyArray<readonly [number, number]> = [
  [2, 4],
  [5, 7],
  [8, 8],
  [9, 10],
];

interface Group {
  name: string;
  count: number;
}

const sortGroups = (counts: ReadonlyMap<string, number>): Group[] =>
  [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const bump = (counts: Map<string, number>, key: string, by: number) =>
  counts.set(key, (counts.get(key) ?? 0) + by);

/** Qatorlarni yig'adi (eksport sahifama-sahifa beradi) va faylni quradi. */
export class UndeliveredReport {
  private readonly rows: ReportRow[] = [];
  private readonly sets = new Map<string, FailureSet>();
  private readonly roles = new Map<string, string>();

  constructor(
    private readonly kind: CampaignReportKind,
    private readonly campaignId: string,
  ) {}

  get size(): number {
    return this.rows.length;
  }

  add(item: UndeliveredItem): void {
    const set = this.setOf(item);
    set.count += 1;
    const rawRole = item.role ?? '';
    let role = this.roles.get(rawRole);
    if (role === undefined) {
      role = clean(roleLabel(rawRole));
      this.roles.set(rawRole, role);
    }
    this.rows.push({
      recipientId: item.recipient_id,
      name: clean(item.name),
      role,
      phone: clean(item.phone),
      refId: item.ref_id,
      set,
    });
  }

  /** `inMemoryMaxRows` — faqat test uchun (oqimli yo'lni kichik faylda sinash). */
  async toXlsx(
    now: Date = new Date(),
    inMemoryMaxRows: number = IN_MEMORY_MAX_ROWS,
  ): Promise<Buffer> {
    return this.rows.length > inMemoryMaxRows
      ? this.streamed(now)
      : this.inMemory(now);
  }

  private setOf(item: UndeliveredItem): FailureSet {
    const failures = item.failures.map((failure) => ({
      channel: clean(channelLabel(failure.channel)),
      status: clean(statusLabel(failure.status)),
      reason: clean(reasonLabel(failure)),
      bucket: statusBucket(this.kind, failure.status),
    }));
    const key = JSON.stringify(failures);
    let set = this.sets.get(key);
    if (!set) {
      const tones = failures.map((failure) => BUCKET_TONES[failure.bucket]);
      const channel = failures.map((failure) => failure.channel).join('\n');
      const statuses = failures.map((failure) => failure.status);
      const reason = failures
        .map((failure) => failure.reason || BLANK)
        .join('\n');
      const lines = Math.max(
        lineCount(channel, CHANNEL_WIDTH),
        lineCount(statuses.join('\n'), STATUS_WIDTH),
        lineCount(reason, REASON_WIDTH),
      );
      set = {
        failures,
        channel,
        status:
          failures.length > 1
            ? {
                richText: statuses.map((status, i) => ({
                  text: (i ? '\n' : '') + status,
                  font: reportFont({
                    size: 9,
                    bold: true,
                    color: REPORT_TONES[tones[i]][0],
                  }),
                })),
              }
            : (statuses[0] ?? ''),
        reason,
        tone: new Set(tones).size === 1 ? tones[0] : undefined,
        height: lines <= 1 ? 19 : Math.min(ROW_HEIGHT_MAX, 6 + 13.2 * lines),
        count: 0,
      };
      this.sets.set(key, set);
    }
    return set;
  }

  // ──────────────────────── yozish ────────────────────────

  private async inMemory(now: Date): Promise<Buffer> {
    const workbook = createReport(TITLE, now);
    this.summary(workbook, now);
    const ws = this.listSheet(workbook);
    this.listHead(ws);
    const styles = new RowStyles();
    this.rows.forEach((row, index) => writeRow(ws, row, index, styles));
    this.listFoot(ws);
    return reportToBuffer(workbook);
  }

  private async streamed(now: Date): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    const workbook = new excelStream.xlsx.WorkbookWriter({
      stream: output,
      useStyles: true,
      useSharedStrings: false,
      zip: { zlib: { level: 6 } },
    });
    workbook.creator = 'Elchi Pochta';
    workbook.title = TITLE;
    workbook.created = now;
    // Varaqqa qo'yilmaydigan rasm faylga ham kirmasin (`withLogoFallback`).
    workbook.addImage = () => 0;
    const summary = this.summary(workbook, now);
    summary.commit();

    const ws = this.listSheet(workbook);
    this.listHead(ws);
    ws.getRow(HEADER_ROW).commit();
    const styles = new RowStyles();
    for (const [index, row] of this.rows.entries()) {
      writeRow(ws, row, index, styles);
      ws.getRow(HEADER_ROW + 1 + index).commit();
      if (index % FLUSH_ROWS === FLUSH_ROWS - 1) {
        // Siqish ulgursin (XML xotirada yig'ilmasin) va jarayon band qolmasin.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.listFoot(ws);
    ws.commit();
    await workbook.commit();
    return Buffer.concat(chunks);
  }

  private get subtitle(): string {
    const name =
      this.kind === 'sms' ? 'SMS kampaniyasi' : 'Bildirishnoma kampaniyasi';
    return `${name} №${this.campaignId}`;
  }

  private totals() {
    const failures = { failed: 0, skipped: 0, no_provider: 0 };
    const reasons = new Map<string, number>();
    const channels = new Map<string, Record<UndeliveredBucket, number>>();
    for (const set of this.sets.values()) {
      for (const failure of set.failures) {
        failures[failure.bucket] += set.count;
        bump(reasons, failure.reason || NOT_SET, set.count);
        const channel = channels.get(failure.channel) ?? {
          failed: 0,
          skipped: 0,
          no_provider: 0,
        };
        channel[failure.bucket] += set.count;
        channels.set(failure.channel, channel);
      }
    }
    const roles = new Map<string, number>();
    for (const row of this.rows) bump(roles, row.role || NOT_SET, 1);
    return {
      failures,
      messages: BUCKETS.reduce((sum, bucket) => sum + failures[bucket], 0),
      reasons: sortGroups(reasons),
      roles: sortGroups(roles),
      channels: [...channels]
        .map(([name, counts]) => ({
          name,
          ...counts,
          all: BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0),
        }))
        .sort((a, b) => b.all - a.all || a.name.localeCompare(b.name)),
    };
  }

  private summary(workbook: Workbook, now: Date): Worksheet {
    const { failures, messages, reasons, roles, channels } = this.totals();
    const ws = withLogoFallback(
      addReportSheet(workbook, 'Xulosa', [14, 14, 13, 13, 15, 16], {
        tab: C.action,
        footer: `${TITLE} — xulosa`,
      }),
    );
    let y = addBanner(ws, {
      title: 'Yetkazilmaganlar xulosasi',
      subtitle: this.subtitle,
      right: `${grouped(this.size)} kishi`,
      rightSub: (toTashkentIso(now) ?? '').replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}).*$/,
        '$3.$2.$1 $4',
      ),
    });
    const failedShare = messages ? (failures.failed / messages) * 100 : 0;
    y = addKpis(ws, y, [
      {
        label: 'Yetkazilmagan qabul qiluvchi',
        value: this.size,
        fmt: COUNT_FMT,
        sub: `${grouped(messages)} ta kanal xabari`,
      },
      {
        label: BUCKET_LABELS.failed,
        value: failures.failed,
        fmt: COUNT_FMT,
        tone: 'danger',
        sub: `kanal xabarlarining ${failedShare.toFixed(1).replace('.', ',')}%`,
      },
      {
        label: BUCKET_LABELS.skipped,
        value: failures.skipped,
        fmt: COUNT_FMT,
        sub: `provayder ulanmagan: ${grouped(failures.no_provider)} ta`,
      },
    ]);
    y = shareTable(ws, y, {
      title: "Sabablar bo'yicha",
      note: "bir kishida bir nechta kanal bo'lishi mumkin",
      head: 'Sabab',
      unit: 'Xabarlar',
      rows: topGroups(reasons, REASONS_MAX),
    });
    y = addSection(
      ws,
      y,
      "Kanallar bo'yicha",
      `${grouped(messages)} ta kanal xabari`,
    );
    y = addTable(ws, y, {
      rows: channels,
      total: true,
      columns: [
        { header: 'Kanal', value: (row) => row.name, span: 2, bold: true },
        {
          header: BUCKET_LABELS.failed,
          value: (row) => row.failed,
          fmt: REPORT_FMT.somDash,
          color: C.danger,
          sum: true,
        },
        {
          header: BUCKET_LABELS.skipped,
          value: (row) => row.skipped,
          fmt: REPORT_FMT.somDash,
          sum: true,
        },
        {
          header: BUCKET_LABELS.no_provider,
          value: (row) => row.no_provider,
          fmt: REPORT_FMT.somDash,
          color: C.warning,
          sum: true,
        },
        {
          header: 'Jami',
          value: (row, r) => formula(`SUM(D${r}:F${r})`, row.all),
          fmt: REPORT_FMT.int,
          bold: true,
          sum: true,
        },
      ],
    }).next;
    shareTable(ws, y, {
      title: "Rollar bo'yicha",
      head: 'Rol',
      unit: 'Kishi',
      rows: roles,
    });
    return ws;
  }

  private listSheet(workbook: Workbook): Worksheet {
    const ws = withLogoFallback(
      addReportSheet(
        workbook,
        'Yetkazilmaganlar',
        COLUMNS.map((column) => column.width),
        { freeze: HEADER_ROW, footer: TITLE },
      ),
    );
    ws.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`;
    return ws;
  }

  /** Lenta, ko'rsatkichlar (6–7) va jadval sarlavhasi (9). */
  private listHead(ws: Worksheet): void {
    const { failures } = this.totals();
    const top = addBanner(ws, {
      title: TITLE,
      subtitle: this.subtitle,
      right: `${grouped(this.size)} kishi`,
      rightSub: 'telefon maskalangan',
    });
    const items: Array<{ label: string; value: number; tone?: ReportTone }> = [
      { label: 'Qabul qiluvchi', value: this.size },
      { label: BUCKET_LABELS.failed, value: failures.failed, tone: 'danger' },
      { label: BUCKET_LABELS.skipped, value: failures.skipped },
      {
        label: BUCKET_LABELS.no_provider,
        value: failures.no_provider,
        tone: 'warning',
      },
    ];
    ws.getRow(top).height = 15;
    ws.getRow(top + 1).height = 21;
    ws.getRow(top + 2).height = 8;
    items.forEach((item, i) => {
      const [from, to] = KPI_SPANS[i];
      const [fg, bg] = item.tone
        ? REPORT_TONES[item.tone]
        : ([C.text, C.sunken] as const);
      for (const r of [top, top + 1]) {
        if (to > from) ws.mergeCells(r, from, r, to);
        eachCell(ws, r, from, r, to, (cell) => {
          cell.fill = solid(bg);
          cell.border = {
            left: edge(C.white, 'thick'),
            ...(r === top
              ? { top: edge(item.tone ? fg : C.borderStrong, 'medium') }
              : {}),
          };
        });
      }
      const label = ws.getCell(top, from);
      label.value = item.label;
      label.font = reportFont({ size: 8.5, color: C.muted });
      label.alignment = { vertical: 'middle', indent: 1 };
      const value = ws.getCell(top + 1, from);
      value.value = item.value;
      value.font = reportFont({ size: 13, bold: true, color: fg });
      value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      value.numFmt = COUNT_FMT;
    });
    ws.getRow(HEADER_ROW).height = 28;
    COLUMNS.forEach((column, i) => {
      const center = column.align === 'center';
      const cell = ws.getCell(HEADER_ROW, FIRST_COLUMN + i);
      cell.value = column.header;
      cell.fill = solid(C.navy);
      cell.border = { right: edge(C.navyLine) };
      cell.font = reportFont({ size: 9, bold: true, color: C.white });
      cell.alignment = {
        vertical: 'middle',
        horizontal: center ? 'center' : 'left',
        wrapText: true,
        indent: center ? 0 : 1,
      };
    });
  }

  /** JAMI (filtrga moslashadi) va filtr. */
  private listFoot(ws: Worksheet): void {
    const first = HEADER_ROW + 1;
    if (!this.size) {
      ws.mergeCells(first, FIRST_COLUMN, first, LAST_COLUMN);
      ws.getRow(first).height = 24;
      const cell = ws.getCell(first, FIRST_COLUMN);
      cell.value = "Yetkazilmaganlar yo'q";
      cell.font = reportFont({ italic: true, color: C.subtle });
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      eachCell(ws, first, FIRST_COLUMN, first, LAST_COLUMN, (item) => {
        item.border = { bottom: edge() };
      });
      return;
    }
    const last = HEADER_ROW + this.size;
    const total = last + 1;
    ws.getRow(total).height = 24;
    eachCell(ws, total, FIRST_COLUMN, total, LAST_COLUMN, (cell) => {
      cell.fill = solid(C.actionSoft);
      cell.border = {
        top: edge(C.action, 'medium'),
        bottom: edge(C.action),
      };
      cell.font = reportFont({ bold: true, color: C.navy });
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    });
    const label = ws.getCell(total, FIRST_COLUMN);
    label.value = 'JAMI';
    label.alignment = { vertical: 'middle', horizontal: 'left' };
    const count = ws.getCell(total, FIRST_COLUMN + 2);
    // № ustuni bo'yicha: qabul qiluvchi ID'si bo'sh qator ham sanaladi.
    count.value = formula(
      `SUBTOTAL(2,${NUMBER_COLUMN}${first}:${NUMBER_COLUMN}${last})`,
      this.size,
    );
    count.numFmt = PERSON_FMT;
    ws.autoFilter = {
      from: { row: HEADER_ROW, column: FIRST_COLUMN },
      to: { row: last, column: LAST_COLUMN },
    };
  }
}

/**
 * Oqimli varaqda `addImage` yo'q: logotip o'rnida lentadagi «ELCHI POCHTA»
 * yozuvi qoladi (B–C birlashadi — yozuv kesilmasin).
 */
const withLogoFallback = (ws: Worksheet): Worksheet => {
  const target = ws as { addImage?: Worksheet['addImage'] };
  target.addImage ??= () => ws.mergeCells(2, 2, 2, 3);
  return ws;
};

/** Ustun × fon × ton bo'yicha bitta uslub obyekti — hamma qatorga umumiy. */
class RowStyles {
  private readonly cache = new Map<string, Partial<Style>>();

  of(
    i: number,
    zebra: boolean,
    blank: boolean,
    tone: ReportTone | undefined,
  ): Partial<Style> {
    const key = `${i}|${zebra}|${blank}|${tone ?? ''}`;
    let style = this.cache.get(key);
    if (!style) {
      const column = COLUMNS[i];
      const center = column.align === 'center';
      style = {
        fill: solid(zebra ? C.canvas : C.white),
        border: { bottom: edge() },
        font: reportFont({
          bold: !blank && Boolean(column.bold || column.status),
          color: blank
            ? C.subtle
            : tone
              ? REPORT_TONES[tone][0]
              : (column.color ?? C.text),
        }),
        alignment: {
          vertical: 'middle',
          horizontal: center ? 'center' : 'left',
          wrapText: Boolean(column.wrap),
          indent: center ? 0 : 1,
        },
        ...(column.fmt && !blank ? { numFmt: column.fmt } : {}),
      };
      this.cache.set(key, style);
    }
    return style;
  }
}

const writeRow = (
  ws: Worksheet,
  row: ReportRow,
  index: number,
  styles: RowStyles,
): void => {
  const line = ws.getRow(HEADER_ROW + 1 + index);
  line.height = row.set.height;
  COLUMNS.forEach((column, i) => {
    const value = column.value(row, index);
    const blank = value === '' || value === null || value === undefined;
    const cell = line.getCell(FIRST_COLUMN + i);
    cell.value = blank ? BLANK : value;
    cell.style = styles.of(
      i,
      index % 2 === 1,
      blank,
      column.status ? row.set.tone : undefined,
    );
  });
};

/** Ko'p guruh — birinchi `max - 1` tasi + «Boshqalar (n ta)». */
const topGroups = (groups: Group[], max: number): Group[] => {
  if (groups.length <= max) return groups;
  const rest = groups.slice(max - 1);
  return [
    ...groups.slice(0, max - 1),
    {
      name: `Boshqalar (${grouped(rest.length)} ta)`,
      count: rest.reduce((sum, group) => sum + group.count, 0),
    },
  ];
};

/** Nom · soni · ulushi · chiziq jadvali. */
const shareTable = (
  ws: Worksheet,
  row: number,
  o: {
    title: string;
    note?: string;
    head: string;
    unit: string;
    rows: Group[];
  },
): number => {
  const header = addSection(ws, row, o.title, o.note);
  const first = header + 1;
  const total = first + o.rows.length;
  const sum = o.rows.reduce((acc, group) => acc + group.count, 0);
  const max = Math.max(1, ...o.rows.map((group) => group.count));
  const bar = (group: Group, r: number): CellFormulaValue => ({
    formula: `REPT("█",ROUND(E${r}/MAX(E$${first}:E$${total - 1})*12,0))`,
    result: '█'.repeat(Math.round((group.count / max) * 12)),
    date1904: false,
  });
  const table = addTable(ws, header, {
    rows: o.rows,
    total: true,
    columns: [
      { header: o.head, value: (group) => group.name, span: 3, bold: true },
      {
        header: o.unit,
        value: (group) => group.count,
        fmt: REPORT_FMT.int,
        bold: true,
        sum: true,
      },
      {
        header: 'Ulushi',
        value: (group, r) =>
          formula(
            `IF(E$${total}=0,0,E${r}/E$${total})`,
            sum ? group.count / sum : 0,
          ),
        fmt: REPORT_FMT.pct,
        totalValue: formula(`SUM(F${first}:F${total - 1})`, 1),
      },
      { header: '', value: bar, color: C.action },
    ],
  });
  for (let r = first; o.rows.length && r < total; r += 1) {
    ws.getCell(r, 7).font = reportFont({ size: 8, color: C.action });
  }
  return table.next;
};
