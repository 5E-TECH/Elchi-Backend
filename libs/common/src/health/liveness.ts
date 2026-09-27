import { INestApplication, Logger } from '@nestjs/common';

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
 *
 * `extra` (ixtiyoriy) — javobga qo'shimcha maydonlar (masalan ai-service
 * `{ ai: 'enabled' | 'disabled' }`). Har so'rovda chaqiriladi, shuning uchun
 * SINXRON va arzon bo'lishi kerak (RMQ/DB'ga bormasin).
 *
 * ⚠️ `extra` liveness'ni HECH QACHON buzmaydi: u throw qilsa yoki obyekt
 * qaytarmasa — e'tiborsiz qoldiriladi va javob baribir 200. Aks holda
 * qo'shimcha maydondagi xato docker healthcheck orqali sog' konteynerni
 * qayta-qayta o'ldirardi. `status` / `service` / `timestamp` ni `extra`
 * almashtira olmaydi.
 */
export function registerLiveness(
  app: INestApplication,
  serviceName: string,
  extra?: () => Record<string, unknown>,
): void {
  // Healthcheck har necha soniyada uradi — buzilgan `extra` logni to'ldirmasin,
  // bitta WARN yetarli.
  let extraFailureLogged = false;

  const readExtra = (): Record<string, unknown> => {
    if (!extra) return {};
    try {
      const value = extra();
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
      }
    } catch (error) {
      if (!extraFailureLogged) {
        extraFailureLogged = true;
        new Logger('Liveness').warn(
          `${serviceName}: /health qo'shimcha maydonlari o'qilmadi — e'tiborsiz qoldirildi (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }
    return {};
  };

  app
    .getHttpAdapter()
    .get(
      '/health',
      (
        _req: unknown,
        res: { status(code: number): { json(body: unknown): void } },
      ) => {
        const body: Record<string, unknown> = {
          status: 'ok',
          service: serviceName,
          timestamp: new Date().toISOString(),
        };
        for (const [key, value] of Object.entries(readExtra())) {
          if (!(key in body)) body[key] = value;
        }
        res.status(200).json(body);
      },
    );
}
