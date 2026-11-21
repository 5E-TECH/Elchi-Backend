import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * «TEZKOR AMAL» — kunni yakunlash (`POST /orders/bulk/sell`, `/orders/bulk/cancel`).
 *
 * Ilgari frontend har buyurtmaga alohida `POST /orders/sell/:id` yuborardi
 * (6 tadan parallel): 100 ta buyurtma = 100 so'rov. Gateway chegarasi
 * (daqiqasiga 60) va order-service yuklamasi 429 / 500 berar, qayta
 * urinishlar ~100 soniya cho'zilar, varaq yopilsa yakunlash yarmida
 * qolardi. Endi bitta so'rov bir nechta buyurtmani server ichida KETMA-KET
 * bajaradi (bir kuryer / filial kassasi qatorlari uchun qulf raqobati yo'q)
 * va har buyurtma natijasini alohida qaytaradi — bittasining xatosi
 * qolganlarini to'xtatmaydi (BeePost `bulk/sell` naqshi).
 *
 * Har buyurtma odatdagi yakka yo'ldan o'tadi (avtomatik qabul, doira,
 * LC-04, isbot, idempotentlik) — biznes qoidalari ikki joyda yozilmaydi.
 */

/** Bitta so'rovdagi buyurtmalar chegarasi (frontend 20 tadan bo'lib yuboradi). */
export const COURIER_BULK_MAX_ORDERS = 50;

export type CourierBulkActionKind = 'sell' | 'cancel';

export type CourierBulkFailure = {
  order_id: string;
  status_code: number;
  message: string;
};

export type CourierBulkOutcome = {
  succeeded: string[];
  failed: CourierBulkFailure[];
};

/** Bo'sh va takroriy id'lar olib tashlanadi, kirish tartibi saqlanadi. */
export function normalizeCourierBulkOrderIds(
  ids: readonly unknown[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id =
      typeof raw === 'string' || typeof raw === 'number'
        ? String(raw).trim()
        : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Har buyurtma uchun barqaror `Idempotency-Key`: yakunlash kaliti (frontend
 * bitta yakunlashning barcha bo'laklariga AYNI kalitni yuboradi) + amal +
 * buyurtma. Bo'lak qayta yuborilsa yoki xato bergan buyurtma shu yakunlashda
 * qayta urinilsa — order-service amalni ikkinchi marta bajarmaydi (birinchisi
 * o'tgan bo'lsa natijasini qaytaradi). Kalit qisqa (≤ 255): xom kalit sha256.
 * Kalit yo'q — har buyurtma yangi UUID bilan (yakka yo'ldagidek).
 */
export function courierBulkOrderIdempotencyKey(
  runKey: string,
  action: CourierBulkActionKind,
  orderId: string,
): string | undefined {
  if (!runKey) return undefined;
  const digest = createHash('sha256')
    .update(runKey, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `courier-bulk:${digest}:${action}:${orderId}`;
}

const messageOf = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    const parts = value.filter(
      (part): part is string =>
        typeof part === 'string' && Boolean(part.trim()),
    );
    return parts.length ? parts.join('. ') : undefined;
  }
  return typeof value === 'string' && value.trim() ? value : undefined;
};

/**
 * Buyurtma xatosi → `{status_code, message}` (`AllExceptionsFilter` bilan bir
 * xil o'qish: HttpException, RPC xato obyekti `{statusCode, message}`,
 * rxjs `TimeoutError` → 504). Noma'lum xato — 500, ichki matn chiqmaydi.
 */
export function describeCourierBulkError(error: unknown): {
  status_code: number;
  message: string;
} {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : messageOf((response as { message?: unknown } | null)?.message);
    return {
      status_code: error.getStatus(),
      message: message ?? error.message,
    };
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      status_code: 504,
      message: 'Buyurtma xizmati vaqtida javob bermadi (timeout)',
    };
  }
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const nested =
      obj.response && typeof obj.response === 'object'
        ? (obj.response as Record<string, unknown>)
        : undefined;
    const status =
      (typeof obj.statusCode === 'number' && obj.statusCode) ||
      (typeof obj.status === 'number' && obj.status) ||
      (typeof nested?.statusCode === 'number' && nested.statusCode) ||
      500;
    const message =
      messageOf(obj.message) ??
      messageOf(nested?.message) ??
      messageOf(obj.error) ??
      messageOf(nested?.error);
    return {
      status_code: status,
      message: message ?? "Noma'lum xatolik yuz berdi",
    };
  }
  return { status_code: 500, message: "Noma'lum xatolik yuz berdi" };
}

/**
 * Buyurtmalarni KETMA-KET bajaradi: bitta xato qolganlarini to'xtatmaydi.
 * Ketma-ketlik ataylab — bir kuryer kassasi / filial kassasi qatorlari
 * parallel sotuvlarda qulf kutishga tushardi.
 */
export async function runCourierBulkSequential(
  orderIds: readonly string[],
  run: (orderId: string) => Promise<unknown>,
): Promise<CourierBulkOutcome> {
  const succeeded: string[] = [];
  const failed: CourierBulkFailure[] = [];
  for (const orderId of orderIds) {
    try {
      await run(orderId);
      succeeded.push(orderId);
    } catch (error) {
      failed.push({ order_id: orderId, ...describeCourierBulkError(error) });
    }
  }
  return { succeeded, failed };
}
