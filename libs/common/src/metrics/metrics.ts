import { INestApplication } from '@nestjs/common';
import { Registry, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

interface MetricsRequest {
  method: string;
  url: string;
  route?: { path?: string };
  baseUrl?: string;
}
interface MetricsResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  on(event: string, cb: () => void): void;
}

/**
 * Prometheus metrics for an HTTP-facing Nest app (audit observability: no
 * metrics endpoint existed). Registers process/GC/event-loop default metrics, a
 * request-duration histogram + in-flight gauge, and an unauthenticated
 * `GET /metrics` (a raw adapter route, so it bypasses the JWT guard — it lives
 * on the internal port, not routed publicly). Cardinality is bounded by
 * labelling on the matched route *pattern* (`/orders/:id`), never the raw path.
 * Call before `app.listen()`.
 */
export function registerMetrics(
  app: INestApplication,
  serviceName: string,
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

  app
    .getHttpAdapter()
    .get('/metrics', (_req: unknown, res: MetricsResponse) => {
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
