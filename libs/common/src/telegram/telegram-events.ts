/**
 * RMQ hodisasi: api-gateway webhook → notification-service (`BotController`).
 * YAGONA manba (zDUUxyH2) — avval gateway va notification-service'da alohida
 * yozilgan edi.
 *
 * ⚠️ `notification.telegram.update` EMAS — u nom admin RPC'si (telegram_markets
 * guruhini yangilash) uchun band: hodisa o'sha handler'ga tushib, xato bilan
 * DLQ'ga ketardi (2026-10-17 prod: /start javobsiz qoldi).
 */
export const TELEGRAM_UPDATE_EVENT = 'notification.telegram.webhook_update';
