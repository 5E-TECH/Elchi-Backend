/**
 * SIG'IM CHEGARASINI TOPISH (k6 ramping).
 *
 * `main.js` — "hozirgi yuk qanday ushlanadi" degan savolga javob beradi.
 * Bu skript esa boshqa savolga: **qayerda sinadi?** Yuk bosqichma-bosqich
 * oshiriladi va chegara buzilgan nuqta topiladi — ya'ni "kuniga nechta
 * buyurtma" degan raqam TAXMIN emas, o'lchov bo'lib chiqadi.
 *
 * ISHGA TUSHIRISH:
 *   BASE_URL=https://staging.example LOGIN_PHONE=... LOGIN_PASSWORD=... \
 *   k6 run tests/load/capacity.js
 *
 * Bosqichlar (sekundiga so'rov): 5 → 10 → 25 → 50 → 100 → 200.
 * Har bosqich 1 daqiqa. `START`/`PEAK` bilan o'zgartiriladi.
 *
 * NATIJANI QANDAY O'QISH — README.md dagi "Natijani buyurtma/kunga
 * aylantirish" bo'limiga qarang. Qisqasi: chegara buzilmagan ENG YUQORI
 * bosqichni oling, uni bitta buyurtmaga to'g'ri keladigan so'rovlar soniga
 * (odatda 15–40) bo'ling va peak koeffitsientini (3×) hisobga oling.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  BASE_URL,
  CREDENTIALS,
  dateKey,
  daysAgo,
  jsonHeaders,
} from './config.js';

const throttled = new Counter('throttled_429');
const failed = new Rate('failed_requests');
const latency = new Trend('endpoint_latency', true);

const START = Number(__ENV.START || 5);
const PEAK = Number(__ENV.PEAK || 200);
const STAGE = __ENV.STAGE_DURATION || '1m';

function ladder() {
  const stages = [];
  let rate = START;
  while (rate < PEAK) {
    stages.push({ target: rate, duration: STAGE });
    rate = rate * 2;
  }
  stages.push({ target: PEAK, duration: STAGE });
  return stages;
}

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: START,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 1000,
      stages: ladder(),
    },
  },
  thresholds: {
    // Chegara buzilgan bosqich — sig'imning yuqori qirrasi. `abortOnFail`
    // bilan test o'sha yerda to'xtaydi, ya'ni natija aniq ko'rinadi.
    endpoint_latency: [
      { threshold: 'p(95)<1500', abortOnFail: true, delayAbortEval: '20s' },
    ],
    failed_requests: [
      { threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '20s' },
    ],
  },
};

export function setup() {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify(CREDENTIALS), {
    headers: jsonHeaders(),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Login muvaffaqiyatsiz: ${res.status}`);
  }
  const body = res.json();
  const token =
    body?.accessToken ?? body?.access_token ?? body?.data?.accessToken;
  if (!token) throw new Error('Javobda accessToken topilmadi');
  return {
    token,
    startDate: dateKey(daysAgo(30)),
    endDate: dateKey(new Date()),
  };
}

/**
 * Aralash yuk: real CRM'da ekranlar shu nisbatda ochiladi — ro'yxat eng
 * ko'p, dashboard undan kam, pul ekrani eng kam.
 */
export default function (data) {
  const headers = jsonHeaders(data.token);
  const dice = __ITER % 10;

  let url;
  if (dice < 6) {
    url = `${BASE_URL}/orders?page=1&limit=20`;
  } else if (dice < 9) {
    url = `${BASE_URL}/analytics/dashboard?startDate=${data.startDate}&endDate=${data.endDate}`;
  } else {
    url = `${BASE_URL}/finance/cashbox/financial-balanse`;
  }

  const res = http.get(url, { headers });
  latency.add(res.timings.duration);
  if (res.status === 429) {
    throttled.add(1);
  } else {
    failed.add(!(res.status >= 200 && res.status < 300));
  }
  check(res, { 'javob 2xx yoki 429': () => res.status < 300 || res.status === 429 });
}

export function handleSummary(summaryData) {
  const m = summaryData.metrics;
  const p95 = m.endpoint_latency?.values?.['p(95)'] ?? 0;
  const reqRate = m.http_reqs?.values?.rate ?? 0;
  const throttleCount = m.throttled_429?.values?.count ?? 0;

  // Bitta buyurtma butun hayoti davomida ~15–40 API so'rovini keltiradi
  // (yaratish, qabul, skan, pochta, sotuv, hisob-kitob + ekran ko'rishlar).
  // Peak koeffitsienti 3× — kunlik yuk 10 ish soatiga tekis tushmaydi.
  const perOrder = Number(__ENV.REQ_PER_ORDER || 25);
  const peakFactor = Number(__ENV.PEAK_FACTOR || 3);
  const ordersPerDay = Math.round(
    ((reqRate / perOrder) * 3600 * 10) / peakFactor,
  );

  const lines = [
    '',
    '─── SIG\'IM XULOSASI ───────────────────────────────',
    `  O'lchangan so'rov tezligi : ${reqRate.toFixed(1)} req/s`,
    `  p95 kechikish             : ${p95.toFixed(0)} ms`,
    `  429 (rate limit)          : ${throttleCount}`,
    `  Taxminiy sig'im           : ~${ordersPerDay.toLocaleString()} buyurtma/kun`,
    `  (hisob: ${perOrder} so'rov/buyurtma, ${peakFactor}× peak, 10 ish soati)`,
    '',
    throttleCount > 0
      ? "  ⚠️  429 bor — natija YUK emas, CHEGARA o'lchovi. THROTTLE_LIMIT ni ko'taring."
      : '  ✅ Rate limit xalaqit qilmadi.',
    '',
  ].join('\n');

  return {
    stdout: lines,
    'tests/load/capacity-summary.json': JSON.stringify(summaryData, null, 2),
  };
}
