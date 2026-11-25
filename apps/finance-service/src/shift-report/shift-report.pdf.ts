import {
  NBSP,
  PDF_COLORS as C,
  PDF_TONES,
  PdfReport,
  pdfSigned,
  pdfSom,
  pdfText,
  type PdfTableRow,
} from '@app/report-kit/pdf';
import type { ReportTone } from '@app/report-kit';
import {
  tashkentClock,
  tashkentDateTime,
} from '../shift-auto-close/shift-schedule.rules';
import {
  AI_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  type BranchSlice,
  type CourierSlice,
  type MarketPaymentLine,
  type ShiftAccountLine,
  type ShiftMoneyBlock,
  type ShiftReportSnapshot,
} from './shift-report.builders';

/**
 * Smena hisoboti PDF'i (tasdiqlangan D1 — asosiy kassa, D2 — filial). Excel
 * bilan bir xil atama va tartib: ogohlantirishlar → kassa hisobi → kirim /
 * chiqim tarkibi → filiallar, kartalar (faqat asosiy kassa) → kuryerlar →
 * marketlar → imzo. Faqat `snapshot` dan quriladi — hisob-kitob yo'q.
 */

/** Market boshiga PDF'dagi to'lovlar chegarasi (to'lig'i — Excel'da). */
const MARKET_PAYMENTS_LIMIT = 50;
/** Farq izohidagi kartalar chegarasi. */
const ACCOUNT_NOTES_LIMIT = 8;

const METHOD_TONES: Record<string, ReportTone> = {
  cash: 'success',
  click: 'info',
  click_to_market: 'action',
};
const AI_TONES: Record<string, ReportTone> = {
  match: 'success',
  mismatch: 'danger',
  unreadable: 'warning',
  error: 'warning',
  pending: 'info',
};

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
const methodLabel = (method: string) =>
  capitalize(PAYMENT_METHOD_LABELS[method] ?? method);
const aiLabel = (status: string) => AI_STATUS_LABELS[status] ?? status;

type Amount = number | null | undefined;
const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: Amount): number => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
};
function sum<T>(list: readonly T[], of: (item: T) => Amount): number {
  return round2(list.reduce((total, item) => total + num(of(item)), 0));
}
/** Hammasi noma'lum — `null` («—»), aks holda yig'indi. */
function sumKnown<T>(
  list: readonly T[],
  of: (item: T) => Amount,
): number | null {
  return list.some((item) => of(item) != null) ? sum(list, of) : null;
}

const dateTime = (at: Date | string | null | undefined) =>
  at ? tashkentDateTime(at).replace(' ', NBSP) : '—';
const clock = (at: Date | string | null) => (at ? tashkentClock(at) : '—');
const som = pdfSom;
const signed = pdfSigned;
/** 0 / yo'q — «—». */
const dash = (value: Amount) => (value ? som(value) : '—');
const percent = (value: number, all: number) =>
  all && value > 0
    ? `${((value / all) * 100).toFixed(1).replace('.', ',')}%`
    : '—';

const differenceTone = (value: Amount): ReportTone =>
  value == null
    ? 'warning'
    : value < 0
      ? 'danger'
      : value > 0
        ? 'warning'
        : 'success';
const differenceWord = (value: Amount) =>
  value == null
    ? 'Sanalmadi'
    : value < 0
      ? 'Kamomad'
      : value > 0
        ? 'Ortiqcha'
        : 'Mos';

/** Nom (faqat emoji bo'lsa ham) bo'lmasa — `#id`. */
const nameOr = (name: string | null | undefined, id: string | null) =>
  pdfText(name) || (id ? `#${id}` : '—');
const accountName = (line: ShiftAccountLine) =>
  `${line.name}${line.last4 ? ` •${line.last4}` : ''}`;
const received = (slice: CourierSlice) =>
  slice.received ?? slice.total + (slice.reversed ?? 0);

type PaidSlice = {
  payments: ReadonlyArray<Pick<MarketPaymentLine, 'amount' | 'reversed'>>;
};
const paidOf = (slices: readonly PaidSlice[]) =>
  sum(slices, (slice) =>
    sum(
      slice.payments.filter((p) => !p.reversed),
      (p) => p.amount,
    ),
  );
const returnedOf = (slices: readonly PaidSlice[]) =>
  -sum(slices, (slice) =>
    sum(
      slice.payments.filter((p) => p.reversed),
      (p) => p.amount,
    ),
  );

function cashboxTitle(snapshot: ShiftReportSnapshot): string {
  if (snapshot.cashbox_type === 'main') return 'Asosiy kassa';
  const name = pdfText(snapshot.branch_name);
  if (!name) return `Filial kassasi #${snapshot.cashbox_user_id}`;
  return /filial/i.test(name) ? `${name} kassasi` : `${name} filiali kassasi`;
}

function periodText(snapshot: ShiftReportSnapshot): string {
  const [fromDay, fromTime] = tashkentDateTime(snapshot.opened_at).split(' ');
  if (!snapshot.closed_at) return `${fromDay} ${fromTime} – …`;
  const [toDay, toTime] = tashkentDateTime(snapshot.closed_at).split(' ');
  return fromDay === toDay
    ? `${fromDay} · ${fromTime}–${toTime}`
    : `${fromDay} ${fromTime} – ${toDay} ${toTime}`;
}

/** Konvertatsiya / tuzatish: kutilgan − (ochilish + kirim − chiqim). */
function conversion(block: ShiftMoneyBlock): number {
  if (block.expected_balance == null) return 0;
  const value = round2(
    block.expected_balance -
      (num(block.opening_balance) +
        num(block.total_income) -
        num(block.total_expense)),
  );
  return Math.round(value) === 0 ? 0 : value;
}

// ───────────────────────── hisobot ─────────────────────────

interface Report {
  pdf: PdfReport;
  snapshot: ShiftReportSnapshot;
  isMain: boolean;
  branches: BranchSlice[];
  /** Asosiy kassa: naqd + karta; filial: bitta jami (63HO6cBU). */
  blocks: ShiftMoneyBlock[];
  /** Pul sanalgan (hamma blokda farq bor). */
  counted: boolean;
  difference: number | null;
}

const total = (report: Report, key: keyof ShiftMoneyBlock) =>
  sumKnown(report.blocks, (block) => block[key]);

/** Blok nomi bilan: «Naqd» / «Karta» (filialda — bitta). */
const namedBlocks = ({ snapshot, isMain }: Report) =>
  isMain
    ? ([
        ['Naqd', snapshot.cash],
        ['Karta', snapshot.card],
      ] as const)
    : ([['Jami', snapshot.cash]] as const);

function drawHeader(report: Report): void {
  const { pdf, snapshot, isMain, branches, counted, difference } = report;
  const auto = snapshot.close_reason === 'auto';
  const kassa = cashboxTitle(snapshot);
  const shift = `Smena #${snapshot.shift_id}`;
  const period = periodText(snapshot);
  pdf.banner({
    title: isMain ? 'Asosiy kassa — smena hisoboti' : kassa,
    subtitle: isMain ? period : `Smena hisoboti · ${period}`,
    right: shift,
    rightSub: auto ? 'Avtomatik yopilgan' : "Qo'lda yopilgan",
  });
  pdf.meta([
    ['Kassa', kassa],
    ['Smena', `#${snapshot.shift_id}`],
    [
      'Ochgan',
      snapshot.opened_by_system
        ? 'Tizim (avtomatik)'
        : nameOr(snapshot.opened_by_name, snapshot.opened_by),
    ],
    ['Ochilgan', dateTime(snapshot.opened_at)],
    auto
      ? [
          'Yopilish',
          `Avtomatik — ${clock(snapshot.closed_at)}, kassir yopmagan`,
          'warning',
        ]
      : [
          'Yopilish',
          `Qo'lda — ${nameOr(snapshot.closed_by_name, snapshot.closed_by)}`,
        ],
    ['Yopilgan', dateTime(snapshot.closed_at)],
  ]);

  const sources = [
    branches.length ? `${branches.length} ta filial` : '',
    snapshot.couriers.length ? `${snapshot.couriers.length} ta kuryer` : '',
  ].filter(Boolean);
  const partly = report.blocks.some((block) => block.discrepancy != null);
  const perKind = `Naqd ${
    snapshot.cash.discrepancy == null
      ? 'sanalmadi'
      : signed(snapshot.cash.discrepancy)
  } · karta ${
    snapshot.card.discrepancy == null
      ? 'sanalmadi'
      : signed(snapshot.card.discrepancy)
  }`;
  pdf.kpis([
    counted
      ? {
          label: "Sanalgan qoldiq, so'm",
          value: som(total(report, 'closing_balance')),
          tone: 'action',
          sub: isMain
            ? `Kutilgan ${som(total(report, 'expected_balance'))}`
            : 'Kassir topshirgan',
        }
      : {
          label: "Kutilgan qoldiq, so'm",
          value: som(total(report, 'expected_balance')),
          tone: 'action',
          sub: "Tizim bo'yicha",
        },
    counted
      ? {
          label: "Farq, so'm",
          value: signed(difference),
          tone: differenceTone(difference),
          sub: isMain
            ? perKind
            : difference
              ? `${differenceWord(difference)} bor`
              : 'Kassa mos',
        }
      : {
          label: 'Farq',
          value: 'Sanalmadi',
          tone: 'warning',
          sub: isMain && partly ? perKind : 'Kassir pulni sanamagan',
        },
    {
      label: "Kirim, so'm",
      value: som(total(report, 'total_income')),
      tone: 'success',
      sub: sources.join(', ') || "Qabul yo'q",
    },
    {
      label: "Chiqim, so'm",
      value: som(total(report, 'total_expense')),
      tone: 'neutral',
      sub: snapshot.markets.length
        ? `${snapshot.markets.length} ta market va boshqa`
        : "Marketga to'lov yo'q",
    },
  ]);
}

/** Ogohlantirishlar: avto-yopilish, farq, smenalar orasidagi harakat. */
function drawNotes(report: Report): void {
  const { pdf, snapshot, isMain, counted, difference } = report;
  if (snapshot.close_reason === 'auto') {
    pdf.note(
      counted
        ? "Smena jadval bo'yicha avtomatik yopilgan."
        : 'Kassadagi pul sanalmagan, farq hisoblanmadi. Pulni sanab, kutilgan qoldiq bilan solishtiring.',
      'warning',
      `Avtomatik yopildi — ${clock(snapshot.closed_at)}, kassir yopmagan`,
    );
  }

  const wrong = namedBlocks(report).filter(([, block]) => block.discrepancy);
  if (wrong.length) {
    const parts: string[] = [];
    for (const [name, block] of wrong) {
      const lines =
        name === 'Karta'
          ? snapshot.accounts
              .filter((line) => line.difference)
              .map(
                (line) =>
                  `${accountName(line)}: tizimda ${som(line.expected_balance)}, kiritilgan ${som(line.entered_balance)} (AI: ${aiLabel(line.ai_status)}).`,
              )
          : [];
      if (lines.length) {
        parts.push(...lines.slice(0, ACCOUNT_NOTES_LIMIT));
        const rest = lines.length - ACCOUNT_NOTES_LIMIT;
        if (rest > 0) parts.push(`Yana ${rest} ta karta — jadvalda.`);
      } else {
        parts.push(
          `${isMain ? `${name}: s` : 'S'}analgan ${som(block.closing_balance)}, kutilgan ${som(block.expected_balance)}.`,
        );
      }
    }
    const amount = (value: Amount) => `${signed(value)}${NBSP}so'm`;
    pdf.note(
      parts.join('\n'),
      wrong.some(([, block]) => num(block.discrepancy) < 0)
        ? 'danger'
        : 'warning',
      isMain
        ? `Farq bor: ${wrong
            .map(
              ([name, block]) =>
                `${name.toLowerCase()} ${amount(block.discrepancy)} (${differenceWord(block.discrepancy).toLowerCase()})`,
            )
            .join(', ')}`
        : `${differenceWord(difference)}: ${amount(difference)}`,
    );
  }

  const gap = snapshot.between_shifts;
  if (gap && gap.count) {
    pdf.note(
      `Kirim ${som(gap.income)}${NBSP}so'm, chiqim ${som(gap.expense)}${NBSP}so'm, ${gap.count} ta amal. Bu pul smena kirim-chiqimiga kirmagan, faqat ochilish qoldig'ida.`,
      'warning',
      `Smenalar orasida (smenasiz) harakat: ${dateTime(gap.from)} → ${dateTime(gap.to)}`,
    );
  }
}

interface MoneyRow {
  label: string;
  cells: string[];
}
const NOT_COUNTED = 'sanalmadi';

/** Ochilish + kirim − chiqim (± konvertatsiya) = kutilgan; sanalgan; FARQ. */
function drawMoneyTable(report: Report, x: number, w: number): void {
  const { pdf, snapshot, isMain, blocks, counted, difference } = report;
  // Ustunlar: naqd, karta, jami; filialda — faqat jami.
  const slots: Array<ShiftMoneyBlock | null> = isMain
    ? [snapshot.cash, snapshot.card, null]
    : [snapshot.cash];
  const cells = (of: (block: ShiftMoneyBlock | null) => string) =>
    slots.map(of);
  const amounts = (key: keyof ShiftMoneyBlock) =>
    cells((block) => som(block ? block[key] : total(report, key)));
  const rows: PdfTableRow<MoneyRow>[] = [
    {
      data: { label: "Ochilish qoldig'i", cells: amounts('opening_balance') },
    },
    {
      data: { label: 'Kirim (+)', cells: amounts('total_income') },
      ink: 'success',
    },
    {
      data: { label: 'Chiqim (−)', cells: amounts('total_expense') },
      ink: 'danger',
    },
    ...(blocks.some(conversion)
      ? [
          {
            data: {
              label: isMain ? 'Konvertatsiya (±)' : 'Tuzatish (±)',
              cells: cells((block) =>
                signed(block ? conversion(block) : sum(blocks, conversion)),
              ),
            },
          },
        ]
      : []),
    {
      data: { label: 'Kutilgan qoldiq', cells: amounts('expected_balance') },
      bold: true,
      tone: 'action',
      ink: 'navy',
    },
    {
      data: {
        label: 'Sanalgan (topshirilgan)',
        cells: cells((block) =>
          block
            ? block.discrepancy == null
              ? NOT_COUNTED
              : som(block.closing_balance)
            : counted
              ? som(total(report, 'closing_balance'))
              : NOT_COUNTED,
        ),
      },
    },
  ];
  const headers = isMain
    ? ["Naqd, so'm", "Karta, so'm", "Jami, so'm"]
    : ["Jami, so'm"];
  const columns = [
    {
      key: 'label',
      header: "Ko'rsatkich",
      weight: isMain ? 3 : 1.5,
      plain: true,
      value: (row: MoneyRow) => row.label,
    },
    ...headers.map((header, i) => ({
      key: `c${i}`,
      header,
      weight: isMain ? 2 : 1.15,
      align: 'right' as const,
      font: 'semibold' as const,
      value: (row: MoneyRow) => row.cells[i],
      tone: (row: MoneyRow): ReportTone | null =>
        row.cells[i] === NOT_COUNTED ? 'warning' : null,
    })),
  ];
  pdf.table({ columns, rows, x, w, zebra: false, paginate: false });

  // Farq — jadvalning oxirgi, katta qatori (raqam + holat).
  const y = pdf.y - pdf.gap;
  const h = pdf.dense ? 29 : 32;
  const cy1 = y + h * 0.36;
  const cy2 = y + h * 0.75;
  const weights = columns.reduce((s, c) => s + c.weight, 0);
  let cx = x;
  columns.forEach((column, i) => {
    const cw = (column.weight / weights) * w;
    const last = i === columns.length - 1;
    const slot = i ? slots[i - 1] : null;
    const value = slot ? slot.discrepancy : difference;
    const [fg, bg] = i
      ? PDF_TONES[differenceTone(value)]
      : ([C.navy, C.sunken] as const);
    pdf.rect(cx, y, last ? cw : cw + 0.4, h, bg);
    if (!i) {
      pdf.put('Farq', cx + 7, cy1, cw, {
        weight: 'bold',
        size: 10.5,
        color: C.navy,
      });
      pdf.put('Holat', cx + 7, cy2, cw, { size: 8, color: C.muted });
    } else {
      const unknown = value == null;
      pdf.put(unknown ? NOT_COUNTED : signed(value), cx + 7, cy1, cw - 14, {
        weight: 'bold',
        size: unknown ? 10 : 11,
        color: fg,
        align: 'right',
      });
      pdf.put(
        unknown ? 'Kassir sanamagan' : differenceWord(value),
        cx + 7,
        cy2,
        cw - 14,
        { weight: 'semibold', size: 8, color: fg, align: 'right' },
      );
    }
    cx += cw;
  });
  pdf.rect(x, y - 0.4, w, 1.2, C.navy);
  pdf.rect(x, y + h - 0.6, w, 1.2, C.navy);
  pdf.y = y + h + pdf.gap;
}

type Flow = [label: string, amount: number];

/**
 * Kirim manbalari va chiqim yo'nalishlari: ma'lum bo'laklar, qolgani —
 * «Boshqa». Filialda `hq_transfers` bo'lsa HQ'ga topshirilgan pul alohida.
 */
function flows(report: Report): { income: Flow[]; expense: Flow[] } {
  const { snapshot, isMain, branches } = report;
  const { couriers, markets } = snapshot;
  const income = num(total(report, 'total_income'));
  const expense = num(total(report, 'total_expense'));
  const branchIn = paidOf(branches);
  const branchBack = returnedOf(branches);
  const courierIn = sum(couriers, received);
  const courierBack = sum(couriers, (c) => c.reversed);
  const marketOut = paidOf(markets);
  const marketBack = returnedOf(markets);
  const hq = isMain ? null : snapshot.hq_transfers;
  const hqBack = num(hq?.reversed);
  // `total` — sof; kassadan chiqqani (yalpi) = sof + qaytarilgani.
  const hqOut = hq ? round2(num(hq.total) + hqBack) : 0;
  const some = (list: Flow[]) =>
    list
      .map(([label, amount]): Flow => [label, round2(amount)])
      .filter(([, amount]) => Math.round(amount) !== 0);
  return {
    income: some([
      ['Filiallardan qabul', branchIn],
      ['Kuryerlardan qabul', courierIn],
      ['Marketdan qaytgan', marketBack],
      ["HQ'dan qaytgan", hqBack],
      ['Boshqa kirim', income - branchIn - courierIn - marketBack - hqBack],
    ]),
    expense: some([
      ["Marketlarga to'lov", marketOut],
      ['Filialga qaytarilgan', branchBack],
      ['Kuryerga qaytarilgan', courierBack],
      [`HQ'ga topshirilgan (${hq?.count ?? 0} ta)`, hqOut],
      [
        isMain || hq ? 'Boshqa chiqim' : "Boshqa (HQ'ga, xarajat)",
        expense - marketOut - branchBack - courierBack - hqOut,
      ],
    ]),
  };
}

function drawMoney(report: Report): void {
  const { pdf, isMain, blocks } = report;
  const { income, expense } = flows(report);
  const half = (pdf.w - 16) / 2;
  const right = pdf.x + half + 16;
  const hasConversion = blocks.some(conversion);
  if (!isMain) {
    // Chapda: qatorlar + FARQ; o'ngda: kirim va chiqim qatorlari + jami.
    const lines = Math.max(
      hasConversion ? 8 : 7,
      income.length + expense.length + 2,
    );
    pdf.ensure(20 + 21 + lines * 17);
    const y = pdf.y;
    pdf.section('Kassa hisobi', null, { w: half });
    drawMoneyTable(report, pdf.x, half);
    const leftEnd = pdf.y;
    pdf.y = y;
    pdf.section('Kirim va chiqim tarkibi', null, { x: right, w: half });
    pdf.table<Flow>({
      columns: [
        {
          key: 'k',
          header: 'Manba',
          weight: 1.5,
          plain: true,
          value: (r) => r[0],
        },
        {
          key: 'v',
          header: "Summa, so'm",
          weight: 1.15,
          align: 'right',
          font: 'semibold',
          value: (r) => signed(r[1]),
        },
      ],
      rows: [
        ...income.map((data) => ({ data, ink: 'success' as const })),
        ...expense.map(([label, amount]) => ({
          data: [label, -amount] as Flow,
          ink: 'danger' as const,
        })),
      ],
      total: {
        k: 'Kirim − chiqim',
        v: signed(
          num(total(report, 'total_income')) -
            num(total(report, 'total_expense')),
        ),
      },
      x: right,
      w: half,
      zebra: false,
      paginate: false,
      empty: "Bu smenada harakat yo'q",
    });
    pdf.y = Math.max(leftEnd, pdf.y);
    return;
  }

  pdf.section(
    'Naqd va karta',
    `kutilgan = ochilish + kirim − chiqim${hasConversion ? ' ± konvertatsiya' : ''}`,
    { need: 23 + 6 * 19 + 32 },
  );
  drawMoneyTable(report, pdf.x, pdf.w);
  const flowTable = (
    title: string,
    label: string,
    list: Flow[],
    all: number,
    x: number,
  ) => {
    pdf.section(title, null, { x, w: half });
    pdf.table<Flow>({
      columns: [
        { key: 'k', header: label, weight: 2.25, value: (r) => r[0] },
        {
          key: 'v',
          header: "Summa, so'm",
          weight: 1.6,
          align: 'right',
          font: 'semibold',
          value: (r) => som(r[1]),
        },
        {
          key: 'p',
          header: 'Ulush',
          weight: 1,
          align: 'right',
          color: C.muted,
          value: (r) => percent(r[1], all),
        },
      ],
      rows: list.map((data) => ({ data })),
      total: { k: 'JAMI', v: som(all), p: all ? '100,0%' : '—' },
      x,
      w: half,
      zebra: false,
      paginate: false,
      empty: "Bu smenada harakat yo'q",
    });
    return pdf.y;
  };
  const rows = Math.max(income.length, expense.length, 1);
  pdf.ensure(20 + 23 + rows * 19 + 22);
  const y = pdf.y;
  const leftEnd = flowTable(
    'Kirim manbalari',
    'Manba',
    income,
    num(total(report, 'total_income')),
    pdf.x,
  );
  pdf.y = y;
  const rightEnd = flowTable(
    "Chiqim yo'nalishlari",
    "Yo'nalish",
    expense,
    num(total(report, 'total_expense')),
    right,
  );
  pdf.y = Math.max(leftEnd, rightEnd);
}

/** Tartib raqami ustuni. */
const numberColumn = <T extends { n: number }>() => ({
  key: 'n',
  header: '№',
  weight: 0.6,
  pad: 2,
  align: 'center' as const,
  color: C.subtle,
  value: (row: T) => row.n,
});

function drawBranches({ pdf, branches }: Report): void {
  if (!branches.length) return;
  const list = branches.map((slice, i) => {
    const paid = slice.payments.filter((p) => !p.reversed);
    const cash = paid.filter((p) => p.payment_method === 'cash');
    const card = paid.filter((p) => p.payment_method !== 'cash');
    return {
      n: i + 1,
      name: nameOr(slice.name, slice.branch_id),
      count: paid.length,
      cash: sum(cash, (p) => p.amount),
      card: sum(card, (p) => p.amount),
      back: returnedOf([slice]),
      total: slice.total,
      balance: slice.balance,
    };
  });
  type Row = (typeof list)[number];
  pdf.section('Filiallar', `${list.length} ta filial`, { need: 33 + 3 * 19 });
  pdf.table<Row>({
    columns: [
      numberColumn<Row>(),
      {
        key: 'name',
        header: 'Filial',
        weight: 2,
        font: 'semibold',
        value: (r) => r.name,
      },
      {
        key: 'count',
        header: "To'lov",
        weight: 0.95,
        align: 'right',
        value: (r) => r.count,
      },
      {
        key: 'cash',
        header: "Naqd, so'm",
        weight: 1.75,
        align: 'right',
        value: (r) => dash(r.cash),
      },
      {
        key: 'card',
        header: "Karta, so'm",
        weight: 1.75,
        align: 'right',
        value: (r) => dash(r.card),
      },
      {
        key: 'back',
        header: "Qaytarilgan, so'm",
        weight: 1.85,
        align: 'right',
        value: (r) => dash(r.back),
        tone: (r) => (r.back ? 'danger' : null),
      },
      {
        key: 'total',
        header: "Topshirgan (sof), so'm",
        weight: 1.9,
        align: 'right',
        font: 'bold',
        value: (r) => som(r.total),
      },
      {
        key: 'balance',
        header: "Kassa qoldig'i, so'm",
        weight: 1.85,
        align: 'right',
        value: (r) => som(r.balance),
      },
    ],
    rows: list.map((data) => ({ data })),
    total: {
      name: 'JAMI',
      count: String(sum(list, (r) => r.count)),
      cash: dash(sum(list, (r) => r.cash)),
      card: dash(sum(list, (r) => r.card)),
      back: dash(sum(list, (r) => r.back)),
      total: som(sum(list, (r) => r.total)),
      balance: som(sumKnown(list, (r) => r.balance)),
    },
  });
}

function drawAccounts({ pdf, snapshot, isMain }: Report): void {
  const { accounts } = snapshot;
  if (!isMain || !accounts.length) return;
  const statuses = new Map<string, number>();
  for (const line of accounts) {
    statuses.set(line.ai_status, (statuses.get(line.ai_status) ?? 0) + 1);
  }
  const ai = [...statuses].map(([status, n]) => `${aiLabel(status)} ${n}`);
  const list = accounts.map((line, i) => ({ n: i + 1, line }));
  type Row = (typeof list)[number];
  pdf.section(
    'Kartalar va hisoblar',
    `${accounts.length} ta · AI: ${ai.join(', ')}`,
    { need: 23 + Math.min(3, accounts.length) * 19 },
  );
  pdf.table<Row>({
    columns: [
      numberColumn<Row>(),
      {
        key: 'name',
        header: 'Karta',
        weight: 3,
        font: 'semibold',
        value: (r) => accountName(r.line),
      },
      {
        key: 'expected',
        header: "Tizim qoldig'i, so'm",
        weight: 2,
        align: 'right',
        value: (r) => som(r.line.expected_balance),
      },
      {
        key: 'entered',
        header: "Kiritilgan, so'm",
        weight: 2,
        align: 'right',
        value: (r) => som(r.line.entered_balance),
      },
      {
        key: 'difference',
        header: "Farq, so'm",
        weight: 1.6,
        align: 'right',
        font: 'bold',
        value: (r) => signed(r.line.difference),
        tone: (r) =>
          r.line.difference == null ? null : differenceTone(r.line.difference),
      },
      {
        key: 'ai',
        header: 'AI natijasi',
        weight: 1.7,
        align: 'center',
        badge: true,
        value: (r) => capitalize(aiLabel(r.line.ai_status)),
        tone: (r) => AI_TONES[r.line.ai_status] ?? 'neutral',
      },
    ],
    rows: list.map((data) => ({
      data,
      ...(data.line.difference
        ? { tone: differenceTone(data.line.difference) }
        : {}),
    })),
    total: {
      name: 'JAMI',
      expected: som(sumKnown(accounts, (a) => a.expected_balance)),
      entered: som(sumKnown(accounts, (a) => a.entered_balance)),
      difference: signed(sumKnown(accounts, (a) => a.difference)),
    },
  });
}

function drawCouriers({ pdf, snapshot }: Report): void {
  const { couriers } = snapshot;
  const list = couriers.map((slice, i) => ({ n: i + 1, slice }));
  type Row = (typeof list)[number];
  pdf.section(
    'Kuryerlar',
    couriers.length ? `${couriers.length} ta kuryer` : null,
    { need: 23 + Math.min(3, couriers.length || 1) * 19 },
  );
  pdf.table<Row>({
    columns: [
      numberColumn<Row>(),
      {
        key: 'name',
        header: 'Kuryer',
        weight: 2.6,
        font: 'semibold',
        value: (r) => nameOr(r.slice.name, r.slice.courier_id),
      },
      {
        key: 'count',
        header: "To'lov soni",
        weight: 1.3,
        align: 'right',
        value: (r) => r.slice.count,
      },
      {
        key: 'received',
        header: "Topshirgan, so'm",
        weight: 1.8,
        align: 'right',
        value: (r) => som(received(r.slice)),
      },
      {
        key: 'reversed',
        header: "Qaytarilgan, so'm",
        weight: 1.8,
        align: 'right',
        value: (r) => dash(r.slice.reversed),
        tone: (r) => (r.slice.reversed ? 'danger' : null),
      },
      {
        key: 'net',
        header: "Sof, so'm",
        weight: 1.7,
        align: 'right',
        font: 'bold',
        value: (r) => som(r.slice.total),
      },
      {
        key: 'debt',
        header: "Qolgan qarz, so'm",
        weight: 1.8,
        align: 'right',
        value: (r) => som(r.slice.remaining_debt),
      },
    ],
    rows: list.map((data) => ({ data })),
    empty: "Bu smenada kuryerlardan qabul yo'q",
    total: {
      name: 'JAMI',
      count: String(sum(couriers, (c) => c.count)),
      received: som(sum(couriers, received)),
      reversed: dash(sum(couriers, (c) => c.reversed)),
      net: som(sum(couriers, (c) => c.total)),
      debt: som(sumKnown(couriers, (c) => c.remaining_debt)),
    },
  });
}

function drawMarkets({ pdf, snapshot, isMain }: Report): void {
  const { markets } = snapshot;
  const rows = markets.flatMap((slice): PdfTableRow<MarketPaymentLine>[] => {
    const shown = slice.payments.slice(0, MARKET_PAYMENTS_LIMIT);
    const rest = slice.payments.length - shown.length;
    return [
      {
        group: nameOr(slice.name, slice.market_id),
        info: `${slice.payments.length} ta to'lov`,
        cells: { amount: som(slice.total), balance: som(slice.balance) },
      },
      ...shown.map((data) => ({ data })),
      ...(rest > 0
        ? [{ more: `… yana ${rest} ta to'lov — Excel hisobotda` }]
        : []),
    ];
  });
  const payments = sum(markets, (m) => m.payments.length);
  pdf.section(
    'Marketlar',
    markets.length
      ? `${markets.length} ta market, ${payments} ta to'lov`
      : null,
    { need: 23 + Math.min(3, rows.length || 1) * 20 },
  );
  pdf.table<MarketPaymentLine>({
    rowHeight: 18,
    zebra: false,
    tail: pdf.gap + (isMain ? 58 : 40),
    columns: [
      {
        key: 'at',
        header: 'Market / vaqt',
        weight: 2.1,
        color: C.muted,
        value: (p) => dateTime(p.at),
      },
      {
        key: 'method',
        header: 'Usul',
        weight: 1.8,
        align: 'center',
        badge: true,
        value: (p) => methodLabel(p.payment_method),
        tone: (p) => METHOD_TONES[p.payment_method] ?? 'neutral',
      },
      {
        key: 'card',
        header: 'Karta',
        weight: 2.3,
        value: (p) => p.card_name || '—',
      },
      {
        key: 'note',
        header: 'Izoh',
        weight: 1.25,
        value: (p) => (p.reversed ? 'Qaytarildi' : ''),
        tone: (p) => (p.reversed ? 'danger' : null),
      },
      {
        key: 'amount',
        header: "Summa, so'm",
        weight: 1.7,
        align: 'right',
        value: (p) => som(p.amount),
        tone: (p) => (p.reversed ? 'danger' : null),
      },
      {
        key: 'balance',
        header: "Qoldiq, so'm",
        weight: 1.6,
        align: 'right',
        value: () => '',
      },
    ],
    rows,
    empty: "Bu smenada marketlarga to'lov yo'q",
    total: {
      at: 'JAMI',
      amount: som(sum(markets, (m) => m.total)),
      balance: som(sumKnown(markets, (m) => m.balance)),
    },
  });
}

export interface ShiftPdfOptions {
  /** «Yaratilgan» (sukut — hozir). */
  createdAt?: Date;
  /** Test uchun — siqilmagan oqim. */
  compress?: boolean;
}

export async function buildPdf(
  snapshot: ShiftReportSnapshot,
  options: ShiftPdfOptions = {},
): Promise<Buffer> {
  const isMain = snapshot.cashbox_type === 'main';
  const shift = `Smena #${snapshot.shift_id}`;
  const blocks = isMain ? [snapshot.cash, snapshot.card] : [snapshot.cash];
  const counted = blocks.every((block) => block.discrepancy != null);
  const pdf = new PdfReport({
    title: `${shift} hisoboti`,
    footer: shift,
    head: `${cashboxTitle(snapshot)} · ${shift}`,
    createdAt: tashkentDateTime(options.createdAt ?? new Date()),
    dense: !isMain,
    compress: options.compress,
  });
  const report: Report = {
    pdf,
    snapshot,
    isMain,
    branches: isMain ? (snapshot.branches ?? []) : [],
    blocks,
    counted,
    difference: counted ? sum(blocks, (block) => block.discrepancy) : null,
  };
  drawHeader(report);
  drawNotes(report);
  drawMoney(report);
  drawBranches(report);
  drawAccounts(report);
  drawCouriers(report);
  drawMarkets(report);
  const closer =
    snapshot.close_reason === 'auto' ? '' : pdfText(snapshot.closed_by_name);
  pdf.sign([`Topshirdi: ${closer}`, 'Qabul qildi', 'Sana']);
  return await pdf.toBuffer();
}
