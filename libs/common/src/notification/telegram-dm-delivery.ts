/**
 * (2crjWf7v) «Yozildi ≠ yetadi» — shaxsiy Telegram xabarlari yetkazish
 * hisobotining kontrakti: gateway `GET /telegram/dm-delivery` ↔
 * notification-service `notification.telegram.dm_delivery`.
 *
 * Faqat shu kartaning DOIM shaxsiy chatga ketadigan turlari (guruh nishoni
 * hech qachon berilmaydi — finance-notification.service.ts): kvitansiya,
 * kuryer e'tirozi va kassa eslatmasi. Guruh relay turlari (`delivery.telegram`
 * ni ham yozadi) bu hisobotga kirmaydi — aks holda nisbat aralashib ketadi.
 */
export const TELEGRAM_DM_DELIVERY_TYPES = [
  'finance.payment_received',
  'finance.payment_disputed',
  'finance.cash_reminder',
] as const;

export type TelegramDmDeliveryType =
  (typeof TELEGRAM_DM_DELIVERY_TYPES)[number];

/** Sukut — kuryer/market kvitansiyasi (kartaning asosiy metrikasi). */
export const DEFAULT_TELEGRAM_DM_DELIVERY_TYPE: TelegramDmDeliveryType =
  'finance.payment_received';

export const TELEGRAM_DM_DELIVERY_PATTERN = 'notification.telegram.dm_delivery';
