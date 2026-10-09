import { GatewayTimeoutException } from '@nestjs/common';

/**
 * D148eHMA — skaner uchun YENGIL buyurtma javobi (`?view=light`).
 *
 * `GET /orders/qr-code/:token` va `GET /scan/:token` (buyurtma tokeni) ODATIY
 * holda o'z javobini o'zgarishsiz qaytaradi. `?view=light` berilgandagina
 * order-service'ning `order.find_by_qr_light` yo'li chaqiriladi: faqat skaner
 * ekranlari ishlatadigan maydonlar (id/token/holat/summa/manzil + mijoz,
 * market, tuman/viloyat, mahsulot NOMLARI). Maydonlar ro'yxati:
 * `apps/order-service/src/lookup/order-scan-light.view.ts`.
 */
export const ORDER_QR_LIGHT_VIEW = 'light';

export const ORDER_FIND_BY_QR_LIGHT = { cmd: 'order.find_by_qr_light' };

/** `?view=` qiymati yengil ko'rinishmi. Boshqa har qanday qiymat — to'liq. */
export function isOrderQrLightView(view: unknown): boolean {
  return (
    typeof view === 'string' &&
    view.trim().toLowerCase() === ORDER_QR_LIGHT_VIEW
  );
}

/**
 * RMQ xatosi "topilmadi" (404) mi? Order-service `RpcException({statusCode})`
 * tashlaydi — mikroservis uni plain obyekt sifatida yuboradi; RpcException
 * instance holati ham qamrab olinadi.
 */
export function isRpcNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const getError = (error as { getError?: unknown }).getError;
  const raw = (
    typeof getError === 'function'
      ? (getError as () => unknown).call(error)
      : error
  ) as { statusCode?: number; status?: number } | null;
  return raw?.statusCode === 404 || raw?.status === 404;
}

/**
 * Yengil qidiruvni yuboradi. Order-service hali yangilanmagan bo'lsa
 * (handler yo'q — rolling deploy/rollback) `fallback` (to'liq javob, u
 * yengilning USTKI to'plami) ga qaytadi, ya'ni frontend sinmaydi.
 *
 * ⚠️ 404 va timeout QAYTA so'ralmaydi: mavjud bo'lmagan token skanida ikkinchi
 * DB so'rovi (va ikki baravar kutish) bo'lmasin — skaner tezligi shu kartaning
 * maqsadi.
 */
export async function sendOrderQrLight<T>(
  send: (pattern: { cmd: string }) => Promise<T>,
  fallback: { cmd: string },
): Promise<T> {
  try {
    return await send(ORDER_FIND_BY_QR_LIGHT);
  } catch (error) {
    if (error instanceof GatewayTimeoutException || isRpcNotFoundError(error)) {
      throw error;
    }
    return send(fallback);
  }
}
