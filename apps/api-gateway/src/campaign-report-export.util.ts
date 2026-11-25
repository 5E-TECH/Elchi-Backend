import { XLSX_MIME } from '@app/report-kit';
import type { Response } from 'express';

/**
 * (H7kpCman) Kampaniya "Yetkazilmaganlar" eksporti — RPC javobi → HTTP.
 * notification-service ≤ 10 000 qatorni darhol fayl bilan qaytaradi (200);
 * kattasini fon vazifasi qiladi (202 JSON `{ export_id, status }`).
 *
 * Fayl ikki xil keladi: `file_base64` — Excel (.xlsx); `csv` — eski tugagan fon
 * eksporti yoki hali yangilanmagan notification-service.
 */
export const CAMPAIGN_EXPORT_TIMEOUT_MS = 60_000;
/** RPC so'rovdagi belgi: bu gateway `file_base64` ni tushunadi. */
export const CAMPAIGN_EXPORT_ACCEPT = 'xlsx';

interface ExportPayload {
  csv?: unknown;
  file_base64?: unknown;
  filename?: unknown;
  content_type?: unknown;
  rows?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

function sendFile(
  res: Response,
  data: ExportPayload,
  body: string | Buffer,
  fallback: { filename: string; contentType: string },
): void {
  const filename =
    asText(data.filename).replace(/[^\w.-]/g, '_') || fallback.filename;
  res.status(200);
  res.set('Content-Type', asText(data.content_type) || fallback.contentType);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('X-Export-Total', asText(data.rows));
  res.set('Cache-Control', 'no-store');
  res.send(body);
}

export function sendCampaignExport(res: Response, result: unknown): void {
  const data = ((result as { data?: unknown } | null)?.data ?? result) as
    ExportPayload | null | undefined;
  if (data && typeof data.csv === 'string') {
    sendFile(res, data, data.csv, {
      filename: 'export.csv',
      contentType: 'text/csv; charset=utf-8',
    });
    return;
  }
  if (data && typeof data.file_base64 === 'string' && data.file_base64) {
    sendFile(res, data, Buffer.from(data.file_base64, 'base64'), {
      filename: 'export.xlsx',
      contentType: XLSX_MIME,
    });
    return;
  }
  res.status(202).json(result);
}
