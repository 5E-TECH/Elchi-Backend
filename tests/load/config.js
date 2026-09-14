/**
 * Yuk testining umumiy sozlamalari va yordamchi funksiyalari.
 *
 * ⚠️ BU TEST PRODUKSIYAGA QARSHI YURGIZILMASIN. `create_orders` senariysi
 * HAQIQIY buyurtma yaratadi (va u bilan bog'liq kassa yozuvlarini
 * qo'zg'atishi mumkin). Shuning uchun yozuvchi senariylar `WRITE=1` bilan
 * ATAYLAB yoqiladi va staging bazasida ishlatiladi.
 */
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3004').replace(
  /\/+$/,
  '',
);

export const CREDENTIALS = {
  phone_number: __ENV.LOGIN_PHONE || '',
  password: __ENV.LOGIN_PASSWORD || '',
};

/** Yozuvchi senariylar faqat ataylab yoqilganda ishlaydi. */
export const WRITE_ENABLED = String(__ENV.WRITE || '') === '1';

/** Buyurtma yaratish uchun kerakli ma'lumotnoma id'lari (staging'dan). */
export const SEED = {
  market_id: __ENV.SEED_MARKET_ID || '',
  region_id: __ENV.SEED_REGION_ID || '',
  district_id: __ENV.SEED_DISTRICT_ID || '',
};

/**
 * ⚠️ RATE LIMIT. Gateway sukut bo'yicha IP bo'yicha daqiqasiga 60 so'rovga
 * ruxsat beradi — ya'ni yuk testi darhol 429 ga uriladi va natija YUK emas,
 * CHEGARA o'lchovi bo'lib qoladi. Staging'da testdan oldin:
 *
 *     THROTTLE_LIMIT=100000 THROTTLE_TTL_MS=60000
 *
 * Skript 429 larni alohida sanaydi va oxirida ogohlantiradi — jim qolmaydi.
 */
export function jsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function pad(value) {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` — analitika endpointlari shu formatni kutadi. */
export function dateKey(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

export function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
