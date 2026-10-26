import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { captureException } from '../sentry/sentry.helper';
import { requestContext } from '../context/request-context';
import { publicErrorData, publicErrorFields } from './public-error-fields';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    // Forward unexpected (5xx) exceptions to Sentry. captureException itself
    // ignores 4xx-shaped business errors so this is safe to call unguarded.
    captureException(exception);
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    // An rxjs `timeout()` firing on a downstream RPC surfaces here as a
    // TimeoutError. The api-gateway is literally a gateway to the
    // microservices, so a stalled upstream is a 504 Gateway Timeout — not an
    // opaque 500. (Matches the per-RPC timeouts added to the gateway sends.)
    const isUpstreamTimeout =
      exception instanceof Error && exception.name === 'TimeoutError';

    let status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isUpstreamTimeout
          ? HttpStatus.GATEWAY_TIMEOUT
          : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const msg = (exceptionResponse as Record<string, unknown>).message;
        if (Array.isArray(msg)) {
          message = msg.join('. ');
        } else if (typeof msg === 'string') {
          message = msg;
        }
      }
    } else if (typeof exception === 'object' && exception !== null) {
      const obj = exception as Record<string, unknown>;
      const nestedResponse =
        typeof obj.response === 'object' && obj.response !== null
          ? (obj.response as Record<string, unknown>)
          : undefined;

      status =
        (typeof obj.statusCode === 'number' && obj.statusCode) ||
        (typeof obj.status === 'number' && obj.status) ||
        (typeof nestedResponse?.statusCode === 'number' &&
          nestedResponse.statusCode) ||
        status;

      const objMessage =
        obj.message ??
        nestedResponse?.message ??
        obj.error ??
        nestedResponse?.error;

      if (Array.isArray(objMessage)) {
        message = objMessage.join('. ');
      } else if (typeof objMessage === 'string' && objMessage.trim()) {
        message = objMessage;
      }
    } else if (exception instanceof Error) {
      const msg = exception.message || '';
      if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
        message = "Bu ma'lumot allaqachon mavjud";
      } else if (msg.includes('foreign key constraint')) {
        message = "Bog'langan ma'lumotlar mavjud, o'chirish mumkin emas";
      } else if (msg.includes('connection') || msg.includes('timeout')) {
        message = "Ma'lumotlar bazasiga ulanishda xatolik";
      } else {
        message = msg || "Noma'lum xatolik yuz berdi";
      }
    }

    if (isUpstreamTimeout) {
      message = 'Yuqori oqim xizmati vaqtida javob bermadi (timeout)';
    }

    // (Elchi Pochta #3) Ro'yxatdagi mashina kodi (`SESSION_TOO_NEW` …) va
    // uning maydonlari — `public-error-fields.ts`; boshqa xatoda bo'sh.
    const extras =
      exception instanceof HttpException
        ? publicErrorFields(exception.getResponse())
        : publicErrorFields(exception);
    // (AF0fvJbw) Ixtiyoriy `data` — faqat `reason`/`usage`/`details`
    // (`public-error-fields.ts`). Manba: HttpException javobi yoki quyi
    // servisning RPC xato obyekti (`{ statusCode, message, data }` — oddiy
    // obyekt, `Error` emas: kutubxona xatolari ichiga qaralmaydi).
    const data =
      exception instanceof HttpException
        ? publicErrorData(exception.getResponse())
        : isRpcErrorPayload(exception)
          ? publicErrorData(exception)
          : undefined;

    const traceId = requestContext.get()?.traceId;

    // Structured 5xx log (Audit observability P1: the filter only sent to Sentry
    // and wrote nothing to the local structured log, so a prod 5xx was invisible
    // without a Sentry lookup). 4xx are client errors — not logged at error level
    // to keep the signal clean.
    if (status >= 500) {
      this.logger.error(
        `${status} ${message} (trace_id=${traceId ?? '-'})`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // (oFfOWGuo) 429 / 503 da `Retry-After` (soniya) — FE kutish vaqtini
    // ko'rsatadi (CORS `exposedHeaders` da). ThrottlerGuard o'zi qo'ygan
    // qiymat saqlanadi; aks holda xato tanasidagi `retry_after_seconds`
    // (LOGIN_LOCKED) / `retry_after` (OTP), bo'lmasa sukut.
    if (status === 429 || status === 503) {
      applyRetryAfterHeader(response, status, exception);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...extras,
      ...(data ? { data } : {}),
      ...(traceId ? { trace_id: traceId } : {}),
    });
  }
}

/**
 * (oFfOWGuo) Sarlavha bo'lmasa qo'llanadigan sukut (soniya): 503 — masalan
 * `SESSION_CHECK_UNAVAILABLE` (identity javob bermadi, qisqa kutib qayta
 * urinish); 429 — global throttle oynasi (60 s).
 */
export const DEFAULT_RETRY_AFTER_SECONDS: Readonly<Record<429 | 503, number>> =
  { 429: 60, 503: 5 };

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function positiveSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.ceil(n), MAX_RETRY_AFTER_SECONDS);
}

/** Xato tanasidagi (HttpException javobi / RPC payload) kutish soniyasi. */
export function retryAfterFromException(
  exception: unknown,
): number | undefined {
  const candidates: unknown[] = [];
  if (exception instanceof HttpException) {
    candidates.push(exception.getResponse());
  } else if (typeof exception === 'object' && exception !== null) {
    candidates.push(exception, (exception as { response?: unknown }).response);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const obj = candidate as Record<string, unknown>;
    const seconds =
      positiveSeconds(obj.retry_after_seconds) ??
      positiveSeconds(obj.retry_after);
    if (seconds) return seconds;
  }
  return undefined;
}

/** 429/503 javobiga `Retry-After` (allaqachon qo'yilgan bo'lsa tegilmaydi). */
export function applyRetryAfterHeader(
  response: Response,
  status: 429 | 503,
  exception: unknown,
): void {
  if (typeof response.setHeader !== 'function') return;
  const existing =
    typeof response.getHeader === 'function'
      ? response.getHeader('Retry-After')
      : undefined;
  if (existing !== undefined && existing !== '') return;
  const seconds =
    retryAfterFromException(exception) ?? DEFAULT_RETRY_AFTER_SECONDS[status];
  response.setHeader('Retry-After', String(seconds));
}

/** Quyi servis RPC xatosi: `{ statusCode: number, ... }` oddiy obyekt. */
function isRpcErrorPayload(exception: unknown): boolean {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    !(exception instanceof Error) &&
    typeof (exception as { statusCode?: unknown }).statusCode === 'number'
  );
}
