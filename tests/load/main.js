/**
 * ELCHI POCHTA — YUK TESTI (k6).
 *
 * MAQSAD. "Kuniga nechta buyurtmani ko'taradi?" degan savolga TAXMIN emas,
 * O'LCHOV bilan javob berish. Audit paytida chegara model asosida
 * baholangan edi (~5 000/kun, keyin Scale 1-bosqichdan so'ng ~30 000);
 * bu skript o'sha raqamlarni haqiqiy o'lchovga almashtiradi.
 *
 * NIMANI O'LCHAYDI (ataylab shu to'rttasi):
 *   • dashboards  — aynan Scale 1-bosqichda tuzatilgan og'ir o'qish yo'llari;
 *                   ilgari ular buyurtmalarni JS xotirasiga yuklardi.
 *   • orders_list — CRM'ning eng ko'p ochiladigan ekrani (sahifalangan).
 *   • money_read  — kassa/hisob-kitob ekrani (M1/C1 tuzatishlaridan keyin).
 *   • create_orders — YOZISH yo'li; faqat `WRITE=1` bilan yoqiladi.
 *
 * ISHGA TUSHIRISH:
 *   BASE_URL=https://staging.example \
 *   LOGIN_PHONE=+998... LOGIN_PASSWORD=... \
 *   k6 run tests/load/main.js
 *
 * Yozish yo'li bilan:
 *   WRITE=1 SEED_MARKET_ID=1 SEED_REGION_ID=1 SEED_DISTRICT_ID=1 \
 *   k6 run tests/load/main.js
 *
 * Bosqichni oshirish (masalan 50 VU gacha):
 *   RATE=50 k6 run tests/load/main.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  BASE_URL,
  CREDENTIALS,
  SEED,
  WRITE_ENABLED,
  dateKey,
  daysAgo,
  jsonHeaders,
} from './config.js';

/** Chegaraga urilgan so'rovlar — natijani jimgina buzmasligi uchun alohida. */
const throttled = new Counter('throttled_429');
const failed = new Rate('failed_requests');
const dashboardLatency = new Trend('dashboard_latency', true);
const ordersListLatency = new Trend('orders_list_latency', true);
const moneyLatency = new Trend('money_latency', true);
const createLatency = new Trend('create_order_latency', true);

const RATE = Number(__ENV.RATE || 10);
const DURATION = __ENV.DURATION || '1m';

export const options = {
  scenarios: {
    dashboards: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE, 10),
      maxVUs: Math.max(RATE * 5, 50),
      exec: 'dashboards',
    },
    orders_list: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE, 10),
      maxVUs: Math.max(RATE * 5, 50),
      exec: 'ordersList',
    },
    money_read: {
      executor: 'constant-arrival-rate',
      rate: Math.max(Math.floor(RATE / 2), 1),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE, 10),
      maxVUs: Math.max(RATE * 3, 30),
      exec: 'moneyRead',
    },
    ...(WRITE_ENABLED
      ? {
          create_orders: {
            executor: 'constant-arrival-rate',
            rate: Math.max(Math.floor(RATE / 2), 1),
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: Math.max(RATE, 10),
            maxVUs: Math.max(RATE * 3, 30),
            exec: 'createOrder',
          },
        }
      : {}),
  },
  thresholds: {
    // Operator ekrani 1 sekunddan tez ochilishi kerak — audit hisobotida
    // "bemalol" zonasi aynan shu bilan belgilangan.
    'dashboard_latency{scenario:dashboards}': ['p(95)<1000'],
    orders_list_latency: ['p(95)<800'],
    money_latency: ['p(95)<1000'],
    failed_requests: ['rate<0.01'],
    // 429 — chegara sozlamasi xatosi, yuk natijasi emas. Nolga yaqin
    // bo'lmasa test natijasini o'qish ma'nosiz.
    throttled_429: ['count<10'],
  },
};

export function setup() {
  if (!CREDENTIALS.phone_number || !CREDENTIALS.password) {
    throw new Error(
      'LOGIN_PHONE va LOGIN_PASSWORD kerak — test autentifikatsiyasiz ishlamaydi',
    );
  }

  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify(CREDENTIALS),
    { headers: jsonHeaders() },
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `Login muvaffaqiyatsiz: ${res.status} ${String(res.body).slice(0, 200)}`,
    );
  }

  const body = res.json();
  const token =
    body?.accessToken ?? body?.access_token ?? body?.data?.accessToken;
  if (!token) {
    throw new Error('Javobda accessToken topilmadi');
  }

  // Analitika oynasi: oxirgi 30 kun — real operator odatda shuni ochadi.
  return {
    token,
    startDate: dateKey(daysAgo(30)),
    endDate: dateKey(new Date()),
  };
}

function track(res, trend) {
  trend.add(res.timings.duration);
  if (res.status === 429) {
    throttled.add(1);
    failed.add(false); // chegara — yuk xatosi emas, alohida sanaladi
    return false;
  }
  const ok = res.status >= 200 && res.status < 300;
  failed.add(!ok);
  return ok;
}

/**
 * Scale 1-bosqichda tuzatilgan og'ir o'qish yo'llari. Regressiya shu yerda
 * darhol ko'rinadi: agar kimdir agregatsiyani yana JS'ga qaytarsa, p95
 * hajm o'sishi bilan chiziqli o'sa boshlaydi.
 */
export function dashboards(data) {
  const headers = jsonHeaders(data.token);
  const query = `startDate=${data.startDate}&endDate=${data.endDate}`;

  const res = http.batch([
    ['GET', `${BASE_URL}/analytics/dashboard?${query}`, null, { headers }],
    [
      'GET',
      `${BASE_URL}/analytics/revenue?${query}&period=daily`,
      null,
      { headers },
    ],
    ['GET', `${BASE_URL}/branches/new-orders`, null, { headers }],
  ]);

  for (const item of res) {
    const ok = track(item, dashboardLatency);
    check(item, { 'dashboard 2xx yoki 429': () => ok || item.status === 429 });
  }
  sleep(0.1);
}

export function ordersList(data) {
  const headers = jsonHeaders(data.token);
  const page = 1 + (__ITER % 5);
  const res = http.get(`${BASE_URL}/orders?page=${page}&limit=20`, { headers });
  const ok = track(res, ordersListLatency);
  check(res, { 'orders 2xx': () => ok || res.status === 429 });
  sleep(0.1);
}

/** M1/C1 tuzatishlaridan keyingi pul ekranlari. */
export function moneyRead(data) {
  const headers = jsonHeaders(data.token);
  const res = http.batch([
    [
      'GET',
      `${BASE_URL}/finance/cashbox/financial-balanse`,
      null,
      { headers },
    ],
    ['GET', `${BASE_URL}/finance/cashbox/all-info?page=1&limit=20`, null, { headers }],
  ]);
  for (const item of res) {
    const ok = track(item, moneyLatency);
    check(item, { 'money 2xx': () => ok || item.status === 429 });
  }
  sleep(0.1);
}

/**
 * YOZISH yo'li. ⚠️ Haqiqiy buyurtma yaratadi — faqat staging'da, `WRITE=1`
 * va seed id'lari bilan ishlaydi.
 */
export function createOrder(data) {
  if (!SEED.market_id) {
    return;
  }
  const headers = jsonHeaders(data.token);
  const payload = JSON.stringify({
    market_id: SEED.market_id,
    region_id: SEED.region_id || undefined,
    district_id: SEED.district_id || undefined,
    where_deliver: 'address',
    total_price: 150000,
    comment: `k6-load-${__VU}-${__ITER}`,
    customer: {
      name: `Yuk testi ${__VU}-${__ITER}`,
      phone_number: `+9989${String(100000000 + (__VU * 1000 + __ITER)).slice(0, 8)}`,
    },
  });

  const res = http.post(`${BASE_URL}/orders`, payload, { headers });
  const ok = track(res, createLatency);
  check(res, { 'create 2xx': () => ok || res.status === 429 });
  sleep(0.2);
}

export function handleSummary(summaryData) {
  const throttleCount =
    summaryData.metrics.throttled_429?.values?.count ?? 0;
  const note =
    throttleCount > 0
      ? `\n⚠️  ${throttleCount} ta so'rov 429 (rate limit) oldi — natija YUK emas, ` +
        `CHEGARA o'lchovi. Staging'da THROTTLE_LIMIT ni ko'taring va qayta yurgizing.\n`
      : '\n✅ Rate limit testga xalaqit qilmadi.\n';

  return {
    stdout: note + JSON.stringify(summaryData.metrics, null, 2) + '\n',
    'tests/load/summary.json': JSON.stringify(summaryData, null, 2),
  };
}
