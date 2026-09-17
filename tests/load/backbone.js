/**
 * UMURTQA SIG'IMI — gateway + RabbitMQ + servis yo'lining shifti.
 *
 * ⚠️ NEGA AYNAN `/health`. U `@SkipThrottle()` bilan rate limitdan ozod
 * (ya'ni chegarani ko'tarmasdan o'lchash mumkin) va autentifikatsiya
 * talab qilmaydi. Ish jihatidan esa u ARZIMAS emas: gateway → RabbitMQ →
 * logistics-service → qaytish — ya'ni HAR BIR so'rov bosib o'tadigan
 * yo'lning aynan o'zi, faqat bazasiz.
 *
 * Natija — QATTIQ YUQORI CHEGARA: hech bir endpoint bundan tez bo'la
 * olmaydi, chunki hammasi shu yo'ldan o'tadi. Baza ishi ustiga qo'shiladi.
 *
 * ISHGA TUSHIRISH:
 *   BASE_URL=https://api.elchipochta.uz k6 run tests/load/backbone.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://api.elchipochta.uz').replace(
  /\/+$/,
  '',
);
const latency = new Trend('backbone_latency', true);
const failed = new Rate('failed_requests');
const throttled = new Counter('throttled_429');
const upstream5xx = new Counter('upstream_5xx');

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 600,
      stages: [
        { target: 10, duration: '20s' },
        { target: 25, duration: '20s' },
        { target: 50, duration: '20s' },
        { target: 100, duration: '20s' },
        { target: 200, duration: '20s' },
      ],
    },
  },
  thresholds: {
    // Chegara buzilgan bosqich — umurtqaning yuqori qirrasi.
    backbone_latency: [
      { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '15s' },
    ],
    failed_requests: [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '15s' },
    ],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  latency.add(res.timings.duration);
  if (res.status === 429) {
    throttled.add(1);
  } else if (res.status >= 500) {
    upstream5xx.add(1);
    failed.add(true);
  } else {
    failed.add(res.status !== 200);
  }
  check(res, { 'health 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const rate = m.http_reqs?.values?.rate ?? 0;
  const p95 = m.backbone_latency?.values?.['p(95)'] ?? 0;
  const med = m.backbone_latency?.values?.med ?? 0;
  const errRate = (m.failed_requests?.values?.rate ?? 0) * 100;

  return {
    stdout:
      '\n─── UMURTQA SIG\'IMI ────────────────────────\n' +
      `  Barqaror tezlik   : ${rate.toFixed(1)} req/s\n` +
      `  Mediana / p95     : ${med.toFixed(0)} / ${p95.toFixed(0)} ms\n` +
      `  Xatolar           : ${errRate.toFixed(2)} %\n` +
      `  429 (rate limit)  : ${m.throttled_429?.values?.count ?? 0}\n` +
      `  5xx (upstream)    : ${m.upstream_5xx?.values?.count ?? 0}\n` +
      '\n  Bu — QATTIQ yuqori chegara: baza ishi ustiga qo\'shiladi.\n\n',
    'tests/load/backbone-summary.json': JSON.stringify(data, null, 2),
  };
}
