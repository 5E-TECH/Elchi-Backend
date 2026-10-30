import type { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * dwJX3NjT — skaner natijasidagi (paket `BTB-`/`BTR-`, pochta `POST-`)
 * buyurtma XULOSASI.
 *
 * Manba — order-service `order.summary_by_ids` (bitta SQL + bitta boyitish,
 * N+1 emas). Skan javobini kuryer ham oladi, shuning uchun bu yerda to'liq
 * buyurtma (tariflar, ulushlar, market profili) EMAS — faqat skaner ekraniga
 * kerakli oq ro'yxat. Shakl gateway `ScanOrderSummary` (MWYaqprw,
 * `order-scan-summary.ts`) ning qismi: `district` / `region` — nom (matn).
 */
export interface ScanOrderSummaryRef {
  id: string;
  order_number: string | null;
  status: string | null;
  total_price: number | null;
  region: string | null;
  district: string | null;
  customer: { name: string | null; phone_number: string | null } | null;
  /** T8: maxsus belgilar (mo'rt, suyuqlik …) — skanda ehtiyot uchun; yo'q — []. */
  special_categories: string[];
}

/** order-service `ORDER_SUMMARY_MAX_IDS` — bitta so'rovdagi id chegarasi. */
export const SCAN_ORDER_SUMMARY_CHUNK = 100;
/**
 * Gateway `GET /scan/:token` va `GET /post/scan/:id` ni 8 s da kesadi —
 * xulosa kechiksa skan baribir (buyurtma mazmunisiz) javob berishi uchun
 * qisqaroq.
 */
export const SCAN_ORDER_SUMMARY_TIMEOUT_MS = 4000;

type Row = Record<string, unknown>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : null;

/** Satrlar massivi (boshqa qiymatlar tashlanadi); massiv emas — []. */
const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** `order.summary_by_ids` qatori → skaner xulosasi (`id` siz qator — `null`). */
export function toScanOrderSummaryRef(
  value: unknown,
): ScanOrderSummaryRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Row;
  const id = text(row.id);
  if (!id) {
    return null;
  }
  const price = Number(row.total_price);
  const customerName = text(row.customer_name);
  const customerPhone = text(row.customer_phone);
  return {
    id,
    order_number: text(row.order_number),
    status: text(row.status),
    total_price: Number.isFinite(price) ? price : null,
    region: text(row.region_name),
    district: text(row.district_name),
    customer:
      customerName || customerPhone
        ? { name: customerName, phone_number: customerPhone }
        : null,
    special_categories: textList(row.special_categories),
  };
}

/**
 * Buyurtma xulosalari `order_id → xulosa`. 100 tadan bo'lib parallel so'raladi.
 * FAIL-SOFT: bo'lak javob bermasa (timeout, xato) u bo'lak buyurtmalari
 * Map'da bo'lmaydi va `onError` chaqiriladi — skan yiqilmaydi.
 */
export async function fetchScanOrderSummaries(
  orderClient: ClientProxy,
  orderIds: string[],
  options?: {
    timeoutMs?: number;
    onError?: (error: unknown, ids: string[]) => void;
  },
): Promise<Map<string, ScanOrderSummaryRef>> {
  const unique = Array.from(
    new Set(
      orderIds.map((id) => String(id ?? '').trim()).filter((id) => id !== ''),
    ),
  );
  const result = new Map<string, ScanOrderSummaryRef>();
  if (!unique.length) {
    return result;
  }

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += SCAN_ORDER_SUMMARY_CHUNK) {
    chunks.push(unique.slice(i, i + SCAN_ORDER_SUMMARY_CHUNK));
  }

  const rows = await Promise.all(
    chunks.map(async (ids) => {
      try {
        const res = await lastValueFrom(
          orderClient
            .send<{ data?: unknown }>({ cmd: 'order.summary_by_ids' }, { ids })
            .pipe(timeout(options?.timeoutMs ?? SCAN_ORDER_SUMMARY_TIMEOUT_MS)),
        );
        return Array.isArray(res?.data) ? (res.data as unknown[]) : [];
      } catch (error) {
        options?.onError?.(error, ids);
        return [];
      }
    }),
  );

  for (const row of rows.flat()) {
    const summary = toScanOrderSummaryRef(row);
    if (summary) {
      result.set(summary.id, summary);
    }
  }
  return result;
}
