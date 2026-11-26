import { type ReportFormat } from '../shift-auto-close/shift-schedule.rules';
import { type ShiftReportSnapshot } from './shift-report.builders';
import { buildPdf } from './shift-report.pdf';
import { buildXlsx } from './shift-report.xlsx';

/** Excel quruvchilari — `shift-report.xlsx.ts` (tasdiqlangan dizayn A1–A4). */
export {
  buildBranchSliceXlsx,
  buildMarketXlsx,
  buildXlsx,
} from './shift-report.xlsx';
/** PDF — `shift-report.pdf.ts` (tasdiqlangan dizayn D1, D2). */
export { buildPdf };

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

export function buildReportFile(
  snapshot: ShiftReportSnapshot,
  format: ReportFormat,
): Promise<Buffer> {
  return format === 'xlsx' ? buildXlsx(snapshot) : buildPdf(snapshot);
}
