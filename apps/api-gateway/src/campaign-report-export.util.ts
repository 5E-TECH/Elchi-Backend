import type { Response } from 'express';

/**
 * (H7kpCman) Kampaniya "Yetkazilmaganlar" CSV eksporti — RPC javobi → HTTP.
 * notification-service ≤ 10 000 qatorni darhol `csv` bilan qaytaradi (200,
 * fayl); kattasini fon vazifasi qiladi (202 JSON `{ export_id, status }`).
 */
export const CAMPAIGN_EXPORT_TIMEOUT_MS = 60_000;

interface ExportPayload {
  csv?: unknown;
  filename?: unknown;
  content_type?: unknown;
  rows?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function sendCampaignExport(res: Response, result: unknown): void {
  const data = ((result as { data?: unknown } | null)?.data ?? result) as
    | ExportPayload
    | null
    | undefined;
  if (data && typeof data.csv === 'string') {
    const filename =
      asText(data.filename).replace(/[^\w.-]/g, '_') || 'export.csv';
    res.status(200);
    res.set(
      'Content-Type',
      asText(data.content_type) || 'text/csv; charset=utf-8',
    );
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Export-Total', asText(data.rows));
    res.set('Cache-Control', 'no-store');
    res.send(data.csv);
    return;
  }
  res.status(202).json(result);
}
