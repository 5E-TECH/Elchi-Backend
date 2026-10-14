import {
  RequestContextStore,
  pickAuditActor,
  pickAuditContext,
  requestContext,
  sanitizeAuditActor,
  sanitizeAuditContext,
} from '../context/request-context';

/**
 * LQWRBwXA — outbox hodisalari ham trace'ni olib o'tadi.
 *
 * Muammo: biznes amali (masalan buyurtma sotuvi) pul hodisasini outbox'ga
 * yozadi, relay esa uni keyinroq, HTTP kontekstisiz yuboradi — qabul
 * qiluvchi servis (finance, notification ...) yozgan jurnal qatorlarida
 * `trace_id`, IP/qurilma va aktyor bo'sh qolardi ("buyurtma → moliya →
 * bildirishnoma" zanjiri uzilardi).
 *
 * Yechim (migratsiyasiz): `enqueue` paytidagi kontekst payload'ning ICHKI
 * kaliti `_audit_ctx` da saqlanadi; relay yuborishdan OLDIN uni olib
 * tashlaydi (handler hech qachon ko'rmaydi) va yuborishni o'sha kontekstda
 * bajaradi — `RequestContextRmqSerializer` trace/audit/aktyor sarlavhalarini
 * qo'yadi, qabul tomonida `RmqTraceInterceptor` tiklaydi.
 *
 * Kontekst bo'lmasa (cron/bot) — kalit qo'shilmaydi (payload avvalgidek).
 */
export const OUTBOX_CONTEXT_KEY = '_audit_ctx';

const TRACE_MAX = 64;

/** `enqueue` uchun: joriy kontekstni payload ichiga (faqat obyekt payload). */
export function attachOutboxContext(
  payload: unknown,
  store: RequestContextStore | undefined = requestContext.get(),
): unknown {
  if (
    !store?.traceId ||
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const obj = payload as Record<string, unknown>;
  if (obj[OUTBOX_CONTEXT_KEY] !== undefined) return obj;
  return {
    ...obj,
    [OUTBOX_CONTEXT_KEY]: {
      traceId: String(store.traceId).slice(0, TRACE_MAX),
      ...pickAuditContext(store),
      ...pickAuditActor(store),
    },
  };
}

/**
 * Relay uchun: payload'dan ichki kalitni ajratadi. `store` — tozalangan
 * kontekst (trace bo'lmasa `null`), `payload` — handler ko'radigan asl shakl.
 */
export function splitOutboxContext(payload: unknown): {
  payload: unknown;
  store: RequestContextStore | null;
} {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !(OUTBOX_CONTEXT_KEY in (payload as Record<string, unknown>))
  ) {
    return { payload, store: null };
  }
  const { [OUTBOX_CONTEXT_KEY]: raw, ...rest } = payload as Record<
    string,
    unknown
  >;
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const traceId =
    typeof source.traceId === 'string' &&
    /^[A-Za-z0-9._:-]{1,64}$/.test(source.traceId)
      ? source.traceId
      : null;
  if (!traceId) return { payload: rest, store: null };
  return {
    payload: rest,
    store: {
      traceId,
      ...sanitizeAuditContext(source),
      ...sanitizeAuditActor(source),
    },
  };
}
