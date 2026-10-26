import { INestApplication } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import type { Metric } from 'prom-client';

export type ReceiveByScanOutcome = 'ok' | 'partial' | 'none';

export const RECEIVE_BY_SCAN_OUTCOMES: readonly ReceiveByScanOutcome[] = [
  'ok',
  'partial',
  'none',
];

/**
 * receive-by-scan natijalari (n9o0KYd5). HTTP kodi har doim 200 (resurs
 * yaratilmaydi), shuning uchun "hech narsa qabul qilinmadi" holatini HTTP
 * metrikasi ko'rmaydi — alert shu hisoblagichga quriladi:
 * `alerts/receive-by-scan.rules.yml` (Prometheus qoida fayli + promtool
 * testi; infra'ga ulanishi kerak).
 * Global registry'ga emas, `registerMetrics` dagi ilova registry'siga ulanadi.
 */
export const receiveByScanTotal = new Counter({
  name: 'receive_by_scan_total',
  help: "receive-by-scan javoblari natija bo'yicha (none = hech narsa qabul qilinmadi)",
  labelNames: ['outcome'],
  registers: [],
});

export function recordReceiveByScanOutcome(
  data: { ok?: boolean; partial?: boolean } | null | undefined,
): ReceiveByScanOutcome {
  const outcome: ReceiveByScanOutcome = !data?.ok
    ? 'none'
    : data.partial
      ? 'partial'
      : 'ok';
  receiveByScanTotal.inc({ outcome });
  return outcome;
}

interface MetricsRequest {
  method: string;
  url: string;
  route?: { path?: string };
  baseUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}
interface MetricsResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  on(event: string, cb: () => void): void;
}

export type MetricsAccess = 'allow' | 'unauthorized' | 'disabled';

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/**
 * (oFfOWGuo, xavfsizlik P1) `GET /metrics` kirish qoidasi. Ilgari
 * autentifikatsiyasiz edi — gateway porti (3004) Cloudflare Tunnel nishoni,
 * ya'ni `https://api.elchipochta.uz/metrics` internetdan ~240 KB route /
 * status / xotira ma'lumotini berardi.
 *  - `METRICS_TOKEN` berilgan → faqat `Authorization: Bearer <token>`
 *    (timing-safe solishtirish); boshqasi 401. Prometheus:
 *    `authorization: { credentials: <token> }`.
 *  - token yo'q + `NODE_ENV=production` → endpoint YOPIQ (404, mavjudligi
 *    ham bilinmaydi). Repo / docker-compose.prod.yml da scraper yo'q.
 *  - token yo'q + dev/test → avvalgidek ochiq (lokal qulaylik).
 */
export function metricsAccess(
  authorization: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MetricsAccess {
  const token = (env.METRICS_TOKEN ?? '').trim();
  if (!token) return env.NODE_ENV === 'production' ? 'disabled' : 'allow';
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match) return 'unauthorized';
  return timingSafeEqual(sha256(match[1]), sha256(token))
    ? 'allow'
    : 'unauthorized';
}

/**
 * Prometheus metrics for an HTTP-facing Nest app (audit observability: no
 * metrics endpoint existed). Registers process/GC/event-loop default metrics, a
 * request-duration histogram + in-flight gauge, and `GET /metrics` (a raw
 * adapter route, so it bypasses the JWT guard — access is decided by
 * `metricsAccess`: METRICS_TOKEN bearer; closed in production without a
 * token). Cardinality is bounded by labelling on the matched route *pattern*
 * (`/orders/:id`), never the raw path.
 * Call before `app.listen()`.
 */
export function registerMetrics(
  app: INestApplication,
  serviceName: string,
  /** Servisga xos metrikalar (masalan notification-service bot metrikalari). */
  extraMetrics: ReadonlyArray<Metric> = [],
): void {
  const register = new Registry();
  register.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [register],
  });
  const inFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'Number of in-flight HTTP requests',
    registers: [register],
  });
  register.registerMetric(receiveByScanTotal);
  for (const metric of extraMetrics) register.registerMetric(metric);
  /**
   * n9o0KYd5 — har natija seriyasi 0 bilan OLDINDAN yaratiladi. prom-client
   * label kombinatsiyasini faqat birinchi `inc()` da chiqaradi: shunda
   * qayta ishga tushgandan keyingi BIRINCHI `received=0` seriyani 1 bilan
   * "paydo" qilardi va `increase()` (kamida ikki namuna) uni ko'rmasdi —
   * alert (alerts/receive-by-scan.rules.yml) aynan birinchi hodisani
   * o'tkazib yuborardi. `inc(…, 0)` qiymatni o'zgartirmaydi.
   */
  for (const outcome of RECEIVE_BY_SCAN_OUTCOMES) {
    receiveByScanTotal.inc({ outcome }, 0);
  }

  app
    .getHttpAdapter()
    .get('/metrics', (req: MetricsRequest, res: MetricsResponse) => {
      const access = metricsAccess(req.headers?.authorization);
      if (access !== 'allow') {
        res.statusCode = access === 'disabled' ? 404 : 401;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (access === 'unauthorized') {
          res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
        }
        res.end(access === 'disabled' ? 'Not Found' : 'Unauthorized');
        return;
      }
      res.setHeader('Content-Type', register.contentType);
      register
        .metrics()
        .then((body) => res.end(body))
        .catch(() => {
          res.statusCode = 500;
          res.end('');
        });
    });

  app.use((req: MetricsRequest, res: MetricsResponse, next: () => void) => {
    if (req.url === '/metrics' || req.url === '/health') return next();
    inFlight.inc();
    const stop = httpDuration.startTimer();
    res.on('finish', () => {
      // req.route is populated after routing; fall back so an unmatched path
      // can't leak the raw (high-cardinality) URL into a label.
      const route = req.route?.path ?? req.baseUrl ?? 'unmatched';
      stop({ method: req.method, route, status_code: res.statusCode });
      inFlight.dec();
    });
    next();
  });
}
