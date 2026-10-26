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
  type ShiftMoneyBlock,
  type ShiftReportSnapshot,
} from './shift-report.builders';

/**
 * gWI4gYkw #3 — superadmin uchun to'liq smena hisoboti fayli (PDF | XLSX).
 * Faqat superadminga ilova qilinadi; kuryer / market faylni olmaydi.
 */

export const REPORT_MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const reportFileName = (shiftId: string, format: ReportFormat) =>
  `smena-${shiftId}-hisobot.${format}`;

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

export async function buildXlsx(
  snapshot: ShiftReportSnapshot,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'Elchi';
  const summary = workbook.addWorksheet('Xulosa');
  summary.columns = [{ width: 28 }, { width: 48 }];
  for (const row of headerRows(snapshot)) summary.addRow(row);
  summary.addRow([]);
  summary.addRow(['NAQD', '']).font = { bold: true };
  for (const row of moneyRows(snapshot.cash)) summary.addRow(row);
  summary.addRow([]);
  summary.addRow(['KARTA', '']).font = { bold: true };
  for (const row of moneyRows(snapshot.card)) summary.addRow(row);

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

  const couriers = workbook.addWorksheet('Kuryerlar');
  couriers.columns = [
    { header: 'Kuryer', width: 30 },
    { header: "To'lovlar soni", width: 14 },
    { header: 'Topshirgan', width: 18 },
    { header: 'Qolgan qarz', width: 18 },
  ];
  for (const slice of snapshot.couriers) {
    couriers.addRow([
      slice.name ?? `#${slice.courier_id}`,
      slice.count,
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
      ]);
    }
  }
  for (const sheet of [cards, couriers, markets]) {
    sheet.getRow(1).font = { bold: true };
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
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
  heading('Naqd');
  for (const [label, value] of moneyRows(snapshot.cash)) line(label, value);
  heading('Karta');
  for (const [label, value] of moneyRows(snapshot.card)) line(label, value);
  if (snapshot.accounts.length) {
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
  heading(`Kuryerlar (${snapshot.couriers.length})`);
  for (const slice of snapshot.couriers) {
    line(
      slice.name ?? `#${slice.courier_id}`,
      `${slice.count} ta, ${formatSom(slice.total)}; qolgan qarz ${
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
            }${payment.card_name ? ` (${payment.card_name})` : ''} · ${tashkentDateTime(payment.at)}`,
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
