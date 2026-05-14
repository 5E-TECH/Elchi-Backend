import * as Sentry from '@sentry/node';
import { RpcException } from '@nestjs/microservices';
import { HttpException } from '@nestjs/common';
import { requestContext } from '../context/request-context';

export interface InitSentryOptions {
  serviceName: string;
  /** Override env (SENTRY_DSN). Omit to read from process.env. */
  dsn?: string;
  /** Override env (SENTRY_ENVIRONMENT). Defaults to NODE_ENV. */
  environment?: string;
  /** Sample rate for `captureException` calls. 1.0 = capture all. */
  sampleRate?: number;
  /** Performance trace sample rate. 0 = disabled. */
  tracesSampleRate?: number;
}

let initialized = false;

/**
 * Initialise Sentry for the current service. Called once from each main.ts.
 *
 * Safe to call without SENTRY_DSN configured: when no DSN is present, every
 * subsequent capture is a no-op. This keeps local/dev runs noise-free without
 * conditional code at the call sites.
 */
export function initSentry(options: InitSentryOptions): void {
  if (initialized) {
    return;
  }
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    // Mark initialized so we don't keep re-checking. Captures will no-op.
    initialized = true;
    return;
  }

  Sentry.init({
    dsn,
    environment: options.environment ?? process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    serverName: options.serviceName,
    sampleRate: options.sampleRate ?? 1.0,
    tracesSampleRate: options.tracesSampleRate ?? 0,
    // Per-event scope: each captureException reads trace_id from ALS so the
    // Sentry event can be cross-referenced with the originating gateway log.
    beforeSend(event) {
      const ctx = requestContext.get();
      if (ctx?.traceId) {
        event.tags = { ...event.tags, trace_id: ctx.traceId };
      }
      if (ctx?.userId) {
        event.user = { ...event.user, id: ctx.userId };
      }
      return event;
    },
  });
  Sentry.setTag('service', options.serviceName);

  initialized = true;
}

/**
 * Determine whether an exception is "expected" (a deliberate 4xx-shaped
 * business error) or "unexpected" (a 5xx-shaped bug worth alerting on).
 * Only unexpected exceptions are sent to Sentry — 4xx noise from validation
 * failures would drown signal.
 */
function isExpectedBusinessError(error: unknown): boolean {
  if (error instanceof HttpException) {
    return error.getStatus() < 500;
  }
  if (error instanceof RpcException) {
    const payload = error.getError();
    if (typeof payload === 'object' && payload !== null) {
      const code = (payload as Record<string, unknown>).statusCode;
      if (typeof code === 'number') return code < 500;
    }
    return false;
  }
  return false;
}

/**
 * Send an exception to Sentry. No-op if Sentry was never initialised (e.g.
 * dev without SENTRY_DSN) or if the error is an expected 4xx business error.
 * Extras are attached as event-scoped context.
 */
export function captureException(
  error: unknown,
  extras?: Record<string, unknown>,
): void {
  if (!initialized) {
    return;
  }
  if (isExpectedBusinessError(error)) {
    return;
  }
  Sentry.withScope((scope) => {
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        scope.setExtra(key, value);
      }
    }
    const ctx = requestContext.get();
    if (ctx?.traceId) {
      scope.setTag('trace_id', ctx.traceId);
    }
    Sentry.captureException(error);
  });
}

/**
 * Flush pending Sentry events. Call from graceful shutdown so the process
 * exits cleanly without losing in-flight error reports.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}
