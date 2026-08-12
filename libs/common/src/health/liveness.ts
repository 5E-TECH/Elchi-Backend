import { INestApplication } from '@nestjs/common';

/**
 * Register a minimal, unauthenticated liveness route on an RMQ worker's HTTP
 * server. Workers bootstrap as hybrid apps (`NestFactory.create` +
 * `app.listen`), so they already run an HTTP server with no routes — this adds
 * `GET /health` returning 200 so a container liveness probe (docker healthcheck)
 * can restart a wedged worker whose event loop has stopped serving.
 *
 * This is deliberately a LIVENESS probe (process responsive), not readiness:
 * the api-gateway owns the richer readiness probe that pings every worker over
 * RMQ. Call this before `app.listen()`.
 */
export function registerLiveness(
  app: INestApplication,
  serviceName: string,
): void {
  app
    .getHttpAdapter()
    .get(
      '/health',
      (
        _req: unknown,
        res: { status(code: number): { json(body: unknown): void } },
      ) => {
        res.status(200).json({
          status: 'ok',
          service: serviceName,
          timestamp: new Date().toISOString(),
        });
      },
    );
}
