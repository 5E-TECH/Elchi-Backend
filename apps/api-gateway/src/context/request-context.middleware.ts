import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  RequestContextStore,
  requestContext,
  sanitizeAuditContext,
} from '@app/common';
import { resolveTrustedClientIp } from '../auth/client-ip-throttler.guard';
import { normalizeIp } from '../auth/ip-allowlist.util';
import { describeUserAgent } from './device-label';

/**
 * Mijoz yuborgan `x-request-id` faqat shu ko'rinishda qabul qilinadi
 * (f2Ud5tju): u endi HAR RMQ chaqiruvida `activity_logs.trace_id`
 * (VARCHAR 64) ga tushadi — uzun/g'alati qiymat INSERT'ni yiqitib, jurnalni
 * jimgina yo'qotardi. Mos kelmasa yangi UUID beriladi.
 */
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Mashina→mashina yo'llari (provayder webhook'lari, SMS DLR). Ularning IP'si
 * mijoz qurilmasi emas — karta talabi: webhook oqimida audit konteksti BO'SH,
 * sun'iy qiymat qo'yilmaydi. (Hamkor API'si `/partner/*` — haqiqiy mijoz
 * serveri, u qamrovda qoladi.)
 */
const MACHINE_PATH_RE = /^\/(?:v\d+\/)?webhooks(?:\/|$)/i;

function firstHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** Frontend kirill/o'zbekcha qiymatni `encodeURIComponent` bilan yuboradi. */
function decodedHeader(req: Request, name: string): string | undefined {
  const value = firstHeader(req, name);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveTraceId(req: Request): string {
  const header = firstHeader(req, 'x-request-id')?.trim();
  return header && TRACE_ID_RE.test(header) ? header : randomUUID();
}

/**
 * HTTP so'rovdan kontekst do'konini quradi (f2Ud5tju):
 * - `ip` — `resolveTrustedClientIp` (rate-limit bilan AYNI manba:
 *   `CF-Connecting-IP`, bo'lmasa `req.ip`) + `normalizeIp` (`::ffff:` prefiks);
 * - `user_agent` — 256 belgigacha kesiladi (`sanitizeAuditContext`);
 * - `device_id` / `device_name` — `X-Device-Id` / `X-Device-Name`; nom
 *   yuborilmasa User-Agent'dan ("Telefon · Android · Chrome").
 */
export function buildRequestContextStore(req: Request): RequestContextStore {
  const traceId = resolveTraceId(req);
  if (MACHINE_PATH_RE.test(req.path ?? req.url ?? '')) {
    return { traceId };
  }
  const userAgent = firstHeader(req, 'user-agent');
  const audit = sanitizeAuditContext({
    ip: normalizeIp(resolveTrustedClientIp(req)) || undefined,
    user_agent: userAgent,
    device_id: decodedHeader(req, 'x-device-id'),
    device_name:
      decodedHeader(req, 'x-device-name') ?? describeUserAgent(userAgent),
  });
  return { traceId, ...audit };
}

/**
 * Trace correlation + audit konteksti: read x-request-id from the client
 * (typical proxy pattern) or mint a fresh one. The id and the audit fields
 * propagate through pino logs, outgoing RMQ calls (AMQP headers —
 * `RequestContextRmqSerializer`) and on into every downstream service, where
 * `ActivityLogService.log()` adds ip/user_agent/device_* to metadata.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const store = buildRequestContextStore(req);
  res.setHeader('x-request-id', store.traceId);
  requestContext.run(store, () => next());
}
