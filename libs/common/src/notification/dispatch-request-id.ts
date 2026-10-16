import { createHash } from 'crypto';

/**
 * Kalitdan barqaror UUID (dispatch `client_request_id` UUID talab qiladi):
 * bir xil kalit (masalan `courier-daily:<user>:<sana>`) → doim bir xil id →
 * notification-service dispatch dedup'i (rzGKtE9N) takrorni yubormaydi.
 */
export function deterministicUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
