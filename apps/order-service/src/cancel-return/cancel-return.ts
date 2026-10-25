/**
 * BEKOR HOLATLARI — bekor qilingan / qaytgan posilka QAYERDA va marketga QANDAY
 * topshirildi (ega qarori 2026-10-19; Trello BG1–BG3: 5Yy6r6UI, fL79tFbs,
 * M0EPcJVf).
 *
 * Bu faylda faqat sof qoidalar (DB/RPC yo'q) — order-service ro'yxat/detal
 * boyitishi, topshirish yo'llari va filtrlar shu yerdagi YAGONA ta'rifni
 * ishlatadi.
 */

/**
 * fL79tFbs (BG2) — marketga topshirish USULI (`orders.market_handover_method`,
 * tracking `metadata.method`):
 *   - `qr`     — market QR'i skan qilingan ruxsat (MHA) bilan;
 *   - `manual` — market QR sessiyasi ichida, posilka yorlig'i shikastlangani
 *                sabab qo'lda tasdiq (`manual_overrides`);
 *   - `no_qr`  — QR talab qilinmasdan (eski market sozlamasi; hozir yo'l yopiq,
 *                faqat eski yozuvlar);
 *   - `pin`    — zaxira PIN (BG6, keyingi karta).
 * Migratsiya 1716000000154 CHECK cheklovi aynan shu ro'yxat.
 */
export const CANCEL_HANDOVER_METHODS = [
  'qr',
  'manual',
  'no_qr',
  'pin',
] as const;
export type CancelHandoverMethod = (typeof CANCEL_HANDOVER_METHODS)[number];

/** Topshirish tracking hodisasi `action` lari (frontend `actionLabelMap` bilan bir xil). */
export const CANCEL_HANDOVER_TRACKING_ACTION: Readonly<
  Record<'qr' | 'manual', string>
> = {
  qr: 'returned_to_market',
  manual: 'cancelled_market_handover_manual',
};
