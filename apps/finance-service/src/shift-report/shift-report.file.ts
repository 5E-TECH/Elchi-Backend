import * as fs from 'node:fs';
import { Workbook } from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  autoClosedLabel,
  tashkentDateTime,
  type ReportFormat,
} from '../shift-auto-close/shift-schedule.rules';
import {
  AI_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  formatSom,
  type BranchSlice,
  type MarketSlice,
  type ShiftMoneyBlock,
  type ShiftReportSnapshot,
} from './shift-report.builders';

/**
 * gWI4gYkw #3 — smena hisoboti fayllari:
 *  - to'liq hisobot (PDF | XLSX) — superadmin; XLSX — filial guruhi /
 *    filial menejerlari (o'z filiali kassasi; asosiy kassa — HQ filiali);
 *  - market Excel'i — FAQAT shu marketning o'z to'lovlari (`buildMarketXlsx`,
 *    boshqa market / kuryer ma'lumoti yo'q);
 *  - filial Excel'i (asosiy kassa smenasi) — FAQAT shu filial HQ'ga topshirgan
 *    pul (`buildBranchSliceXlsx`).
 */

export const REPORT_MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const reportFileName = (shiftId: string, format: ReportFormat) =>
  `smena-${shiftId}-hisobot.${format}`;

export const marketReportFileName = (shiftId: string, marketId: string) =>
  `smena-${shiftId}-market-${marketId}-tolovlar.xlsx`;

export const branchReportFileName = (shiftId: string, branchId: string) =>
  `smena-${shiftId}-filial-${branchId}-hq.xlsx`;

const moneyRows = (block: ShiftMoneyBlock): Array<[string, string]> => [
  ['Ochilish qoldig‘i', formatSom(block.opening_balance)],
  ['Kirim', formatSom(block.total_income)],
  ['Chiqim', formatSom(block.total_expense)],
  ['Kutilgan qoldiq', formatSom(block.expected_balance)],
  [
    'Sanalgan (topshirilgan)',
    block.discrepancy == null ? 'sanalmadi' : formatSom(block.closing_balance),
  ],
  [
    'Farq',
    block.discrepancy == null ? 'sanalmadi' : formatSom(block.discrepancy),
  ],
];

const headerRows = (snapshot: ShiftReportSnapshot): Array<[string, string]> => [
  ['Smena', `#${snapshot.shift_id}`],
  [
    'Kassa',
    snapshot.cashbox_type === 'main'
      ? 'Asosiy kassa'
      : `Filial kassasi #${snapshot.cashbox_user_id}`,
  ],
  [
    'Ochgan',
    snapshot.opened_by_name ??
      (snapshot.opened_by ? `#${snapshot.opened_by}` : '—'),
  ],
  ['Ochilgan', tashkentDateTime(snapshot.opened_at)],
  ['Yopilgan', tashkentDateTime(snapshot.closed_at)],
  [
    'Yopilish',
    snapshot.close_reason === 'auto'
      ? autoClosedLabel(snapshot.closed_at)
      : `Qo'lda — ${snapshot.closed_by_name ?? (snapshot.closed_by ? `#${snapshot.closed_by}` : '—')}`,
  ],
];

function addCardsSheet(workbook: Workbook, snapshot: ShiftReportSnapshot) {
  const cards = workbook.addWorksheet('Kartalar');
  cards.columns = [
    { header: 'Karta', width: 28 },
    { header: 'Tizim qoldig‘i', width: 18 },
    { header: 'Kiritilgan', width: 18 },
    { header: 'Farq', width: 16 },
    { header: 'AI natijasi', width: 18 },
  ];
  for (const line of snapshot.accounts) {
    cards.addRow([
      `${line.name}${line.last4 ? ` •${line.last4}` : ''}`,
      line.expected_balance,
      line.entered_balance,
      line.difference,
      AI_STATUS_LABELS[line.ai_status] ?? line.ai_status,
    ]);
  }

  return cards;
}

export async function buildXlsx(
  snapshot: ShiftReportSnapshot,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'Elchi';
  const summary = workbook.addWorksheet('Xulosa');
  summary.columns = [{ width: 28 }, { width: 48 }];
  for (const row of headerRows(snapshot)) summary.addRow(row);
  // 63HO6cBU — filial smenasi bitta jami: karta bloki va «Kartalar» varag'i yo'q.
  const isBranch = snapshot.cashbox_type === 'branch';
  summary.addRow([]);
  summary.addRow([isBranch ? 'JAMI' : 'NAQD', '']).font = { bold: true };
  for (const row of moneyRows(snapshot.cash)) summary.addRow(row);
  const sheets: ReturnType<Workbook['addWorksheet']>[] = [];
  if (!isBranch) {
    summary.addRow([]);
    summary.addRow(['KARTA', '']).font = { bold: true };
    for (const row of moneyRows(snapshot.card)) summary.addRow(row);
    sheets.push(addCardsSheet(workbook, snapshot));
  }

  const gap = snapshot.between_shifts;
  if (gap && gap.count) {
    summary.addRow([]);
    summary.addRow(['SMENALAR ORASIDA (smenasiz)', '']).font = { bold: true };
    summary.addRow([
      'Oraliq',
      `${tashkentDateTime(gap.from)} → ${tashkentDateTime(gap.to)}`,
    ]);
    summary.addRow(['Kirim', formatSom(gap.income)]);
    summary.addRow(['Chiqim', formatSom(gap.expense)]);
    summary.addRow(['Amallar soni', gap.count]);
  }

  const couriers = workbook.addWorksheet('Kuryerlar');
  couriers.columns = [
    { header: 'Kuryer', width: 30 },
    { header: "To'lovlar soni", width: 14 },
    { header: 'Topshirgan', width: 18 },
    // (T6) shu smenada qaytarilgan to'lovlar va sof summa.
    { header: 'Qaytarilgan', width: 16 },
    { header: 'Sof', width: 18 },
    { header: 'Qolgan qarz', width: 18 },
  ];
  for (const slice of snapshot.couriers) {
    const reversed = slice.reversed ?? 0;
    couriers.addRow([
      slice.name ?? `#${slice.courier_id}`,
      slice.count,
      slice.received ?? slice.total + reversed,
      reversed,
      slice.total,
      slice.remaining_debt,
    ]);
  }

  const markets = workbook.addWorksheet('Marketlar');
  markets.columns = [
    { header: 'Market', width: 30 },
    { header: 'Summa', width: 16 },
    { header: 'Usul', width: 18 },
    { header: 'Karta', width: 22 },
    { header: 'Vaqt', width: 18 },
    { header: 'Qoldiq', width: 18 },
    { header: 'Izoh', width: 14 },
  ];
  for (const slice of snapshot.markets) {
    for (const line of slice.payments) {
      markets.addRow([
        slice.name ?? `#${slice.market_id}`,
        line.amount,
        PAYMENT_METHOD_LABELS[line.payment_method] ?? line.payment_method,
        line.card_name ?? '',
        tashkentDateTime(line.at),
        slice.balance,
        line.reversed ? 'qaytarildi' : '',
      ]);
    }
  }
  if (!isBranch && snapshot.branches?.length) {
    const branches = workbook.addWorksheet('Filiallar');
    branches.columns = [
      { header: 'Filial', width: 30 },
      { header: 'Summa', width: 16 },
      { header: 'Usul', width: 18 },
      { header: 'Vaqt', width: 18 },
      { header: 'Kassa qoldig‘i', width: 18 },
      { header: 'Izoh', width: 14 },
    ];
    for (const slice of snapshot.branches) {
      for (const line of slice.payments) {
        branches.addRow([
          slice.name ?? `#${slice.branch_id}`,
          line.amount,
          PAYMENT_METHOD_LABELS[line.payment_method] ?? line.payment_method,
          tashkentDateTime(line.at),
          slice.balance,
          line.reversed ? 'qaytarildi' : '',
        ]);
      }
    }
    sheets.push(branches);
  }
  for (const sheet of [...sheets, couriers, markets]) {
    sheet.getRow(1).font = { bold: true };
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/**
 * Market Excel'i — FAQAT o'z to'lovlari (`slice`): smena, yopilgan vaqt,
 * har to'lov (summa, usul, karta, vaqt, izoh), jami va qoldiq.
 */
export async function buildMarketXlsx(
  snapshot: Pick<
    ShiftReportSnapshot,
    'shift_id' | 'closed_at' | 'close_reason'
  >,
  slice: MarketSlice,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'Elchi';
  const sheet = workbook.addWorksheet("To'lovlar");
  sheet.columns = [
    { width: 20 },
    { width: 18 },
    { width: 22 },
    { width: 20 },
    { width: 14 },
  ];
  sheet.addRow(['Smena', `#${snapshot.shift_id}`]);
  sheet.addRow(['Market', slice.name ?? `#${slice.market_id}`]);
  sheet.addRow(['Yopilgan', tashkentDateTime(snapshot.closed_at)]);
  sheet.addRow([]);
  const header = sheet.addRow(['Summa', 'Usul', 'Karta', 'Vaqt', 'Izoh']);
  header.font = { bold: true };
  for (const line of slice.payments) {
    sheet.addRow([
      line.amount,
      PAYMENT_METHOD_LABELS[line.payment_method] ?? line.payment_method,
      line.card_name ?? '',
      tashkentDateTime(line.at),
      line.reversed ? 'qaytarildi' : '',
    ]);
  }
  sheet.addRow([]);
  sheet.addRow(['Jami', slice.total]).font = { bold: true };
  if (slice.balance != null) {
    sheet.addRow(['Hisobingizdagi qoldiq', slice.balance]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Filial Excel'i (asosiy kassa smenasi) — FAQAT shu filial HQ'ga topshirgan
 * pul (`slice`): har to'lov (summa, usul, vaqt, izoh), jami, kassa qoldig'i.
 */
export async function buildBranchSliceXlsx(
  snapshot: Pick<ShiftReportSnapshot, 'shift_id' | 'closed_at'>,
  slice: BranchSlice,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'Elchi';
  const sheet = workbook.addWorksheet("HQ'ga topshirilgan");
  sheet.columns = [{ width: 26 }, { width: 18 }, { width: 20 }, { width: 14 }];
  sheet.addRow(['Asosiy kassa smenasi', `#${snapshot.shift_id}`]);
  sheet.addRow(['Filial', slice.name ?? `#${slice.branch_id}`]);
  sheet.addRow(['Yopilgan', tashkentDateTime(snapshot.closed_at)]);
  sheet.addRow([]);
  sheet.addRow(['Summa', 'Usul', 'Vaqt', 'Izoh']).font = { bold: true };
  for (const line of slice.payments) {
    sheet.addRow([
      line.amount,
      PAYMENT_METHOD_LABELS[line.payment_method] ?? line.payment_method,
      tashkentDateTime(line.at),
      line.reversed ? 'qaytarildi' : '',
    ]);
  }
  sheet.addRow([]);
  sheet.addRow(['Jami', slice.total]).font = { bold: true };
  if (slice.balance != null) {
    sheet.addRow(['Filial kassasidagi qoldiq', slice.balance]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const DEJAVU = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];

/** DejaVu bo'lmasa — Helvetica (faqat Latin-1: maxsus belgilar almashtiriladi). */
function latin1(text: string): string {
  return text
    .replace(/[‘’ʻʼ]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/−/g, '-')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7e\xa0-\xff\n]/g, '');
}

export async function buildPdf(snapshot: ShiftReportSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  let unicode = false;
  for (const path of DEJAVU) {
    try {
      if (fs.existsSync(path)) {
        doc.registerFont('Sans', path);
        doc.font('Sans');
        unicode = true;
        break;
      }
    } catch {
      // keyingi nomzod
    }
  }
  if (!unicode) doc.font('Helvetica');
  const t = (text: string) => (unicode ? text : latin1(text));
  const line = (label: string, value: string) =>
    doc.fontSize(10).text(t(`${label}: ${value}`));
  const heading = (text: string) => {
    doc.moveDown(0.6);
    doc.fontSize(12).text(t(text));
    doc.moveDown(0.2);
  };

  doc.fontSize(15).text(t(`Smena #${snapshot.shift_id} hisoboti`));
  doc.moveDown(0.4);
  for (const [label, value] of headerRows(snapshot)) line(label, value);
  // 63HO6cBU — filial smenasi bitta jami (karta bo'limi yo'q).
  const isBranch = snapshot.cashbox_type === 'branch';
  heading(isBranch ? 'Jami' : 'Naqd');
  for (const [label, value] of moneyRows(snapshot.cash)) line(label, value);
  if (!isBranch) {
    heading('Karta');
    for (const [label, value] of moneyRows(snapshot.card)) line(label, value);
  }
  if (!isBranch && snapshot.accounts.length) {
    heading('Kartalar / hisoblar');
    for (const item of snapshot.accounts) {
      line(
        `${item.name}${item.last4 ? ` •${item.last4}` : ''}`,
        `tizim ${formatSom(item.expected_balance)}; kiritilgan ${
          item.entered_balance == null ? '—' : formatSom(item.entered_balance)
        }; farq ${item.difference == null ? '—' : formatSom(item.difference)}; AI: ${
          AI_STATUS_LABELS[item.ai_status] ?? item.ai_status
        }`,
      );
    }
  }
  if (!isBranch && snapshot.branches?.length) {
    heading(`Filiallar (${snapshot.branches.length})`);
    for (const slice of snapshot.branches) {
      line(
        slice.name ?? `#${slice.branch_id}`,
        `${slice.payments.length} ta, ${formatSom(slice.total)}; kassa qoldig‘i ${
          slice.balance == null ? '—' : formatSom(slice.balance)
        }`,
      );
    }
  }
  heading(`Kuryerlar (${snapshot.couriers.length})`);
  for (const slice of snapshot.couriers) {
    line(
      slice.name ?? `#${slice.courier_id}`,
      `${slice.count} ta, ${formatSom(slice.total)}${
        slice.reversed ? ` (qaytarilgan ${formatSom(slice.reversed)})` : ''
      }; qolgan qarz ${
        slice.remaining_debt == null ? '—' : formatSom(slice.remaining_debt)
      }`,
    );
  }
  heading(`Marketlar (${snapshot.markets.length})`);
  for (const slice of snapshot.markets) {
    line(
      slice.name ?? `#${slice.market_id}`,
      `${slice.payments.length} ta, ${formatSom(slice.total)}; qoldiq ${
        slice.balance == null ? '—' : formatSom(slice.balance)
      }`,
    );
    for (const payment of slice.payments.slice(0, 50)) {
      doc
        .fontSize(9)
        .text(
          t(
            `   • ${formatSom(payment.amount)} — ${
              PAYMENT_METHOD_LABELS[payment.payment_method] ??
              payment.payment_method
            }${payment.card_name ? ` (${payment.card_name})` : ''} · ${tashkentDateTime(payment.at)}${
              payment.reversed ? ' — qaytarildi' : ''
            }`,
          ),
        );
    }
  }
  doc.end();
  return done;
}

export function buildReportFile(
  snapshot: ShiftReportSnapshot,
  format: ReportFormat,
): Promise<Buffer> {
  return format === 'xlsx' ? buildXlsx(snapshot) : buildPdf(snapshot);
}
