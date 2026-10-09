import { RmqRecord, Serializer } from '@nestjs/microservices';
import {
  AuditContext,
  RequestContextStore,
  pickAuditContext,
  requestContext,
  sanitizeAuditContext,
} from './request-context';

/**
 * SO'ROV KONTEKSTINI RMQ ORQALI UZATISH (f2Ud5tju).
 *
 * ⚠️ NEGA SARLAVHA (AMQP headers), PAYLOAD EMAS. `trace_id` hozircha faqat
 * `rmqSend` (`withRequestId`) orqali payload'ga qo'shiladi — gateway esa
 * servislarni 300+ joyda to'g'ridan-to'g'ri `client.send(...)` bilan
 * chaqiradi, ya'ni gateway → servis bo'g'inida trace ham, IP ham YETIB
 * BORMASDI. Har bir payload'ga yangi kalit qo'shish esa xavfli: identity va
 * investor servislarida global `ValidationPipe({ forbidNonWhitelisted })`
 * bor, ba'zi handler'lar payload'ni to'g'ridan-to'g'ri repo'ga uzatadi.
 * Sarlavha handler ko'radigan `data` ga TEGMAYDI, lekin xabar bilan birga
 * boradi — shuning uchun mexanizm `RmqModule` dagi BARCHA klientlarga
 * (gateway va servis→servis) shu serializer orqali ulanadi, qabul tomonida
 * esa mavjud `RmqTraceInterceptor` o'qiydi.
 *
 * HTTP bo'lmagan oqimda (cron/bot/outbox relay) ALS bo'sh → sarlavha
 * qo'shilmaydi → qabul qiluvchida kontekst ham bo'sh (sun'iy qiymat yo'q).
 */
export const RMQ_TRACE_HEADER = 'x-trace-id';
export const RMQ_AUDIT_CTX_HEADER = 'x-audit-ctx';

/** RMQ orqali kelgan trace id chegarasi (gateway ham 64 gacha qabul qiladi). */
const TRACE_HEADER_MAX = 64;

/** Joriy kontekstdan chiquvchi xabar sarlavhalari. Kontekst yo'q → `{}`. */
export function buildRmqContextHeaders(
  store: RequestContextStore | undefined = requestContext.get(),
): Record<string, string> {
  if (!store?.traceId) return {};
  const headers: Record<string, string> = {
    [RMQ_TRACE_HEADER]: store.traceId,
  };
  const audit = pickAuditContext(store);
  if (Object.keys(audit).length > 0) {
    headers[RMQ_AUDIT_CTX_HEADER] = JSON.stringify(audit);
  }
  return headers;
}

function headerString(value: unknown): string | undefined {
  const raw = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Kelgan xabarning AMQP sarlavhalari (RmqContext bo'lmasa `{}`). */
export function readRmqHeaders(rpcContext: unknown): Record<string, unknown> {
  const getMessage = (rpcContext as { getMessage?: () => unknown } | null)
    ?.getMessage;
  if (typeof getMessage !== 'function') return {};
  try {
    const message = getMessage.call(rpcContext) as {
      properties?: { headers?: unknown };
    } | null;
    const headers = message?.properties?.headers;
    return headers && typeof headers === 'object'
      ? (headers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `x-trace-id` sarlavhasi (bo'sh/juda uzun bo'lsa `undefined`). */
export function traceIdFromRmqHeaders(
  headers: Record<string, unknown>,
): string | undefined {
  const value = headerString(headers[RMQ_TRACE_HEADER]);
  return value && value.length <= TRACE_HEADER_MAX ? value : undefined;
}

/**
 * `x-audit-ctx` sarlavhasi → tozalangan audit konteksti. Buzuq JSON yoki
 * begona kalitlar jimgina tashlanadi (sarlavha ishonchsiz manba deb qaraladi).
 */
export function auditContextFromRmqHeaders(
  headers: Record<string, unknown>,
): AuditContext {
  const raw = headerString(headers[RMQ_AUDIT_CTX_HEADER]);
  if (!raw) return {};
  try {
    return sanitizeAuditContext(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Nest'ning standart `RmqRecordSerializer` xulqi (RmqRecord → data + options)
 * SAQLANADI, ustiga kontekst sarlavhalari qo'shiladi. Chaqiruvchi
 * `RmqRecordBuilder` bilan o'zi bergan sarlavha USTUN.
 *
 * `ClientProxy.send/emit` serializer'ni chaqiruvchining async kontekstida
 * ishga tushiradi (`defer` → `then` zanjiri), shuning uchun ALS shu yerda
 * ko'rinadi.
 */
export class RequestContextRmqSerializer implements Serializer {
  serialize(packet: unknown): unknown {
    if (!packet || typeof packet !== 'object') return packet;
    let out = packet as Record<string, unknown>;
    let options: Record<string, unknown> | undefined;
    if (out.data instanceof RmqRecord) {
      const record = out.data as RmqRecord<unknown>;
      out = { ...out, data: record.data };
      options = record.options as Record<string, unknown> | undefined;
    }

    const contextHeaders = buildRmqContextHeaders();
    if (Object.keys(contextHeaders).length === 0) {
      return options ? { ...out, options } : out;
    }
    const existing =
      options?.headers && typeof options.headers === 'object'
        ? (options.headers as Record<string, unknown>)
        : {};
    return {
      ...out,
      options: { ...options, headers: { ...contextHeaders, ...existing } },
    };
  }
}
