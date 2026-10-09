import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContextStore {
  traceId: string;
  /** Optional user id when known (gateway extracts from JWT). */
  userId?: string;
  // AUDIT MAYDONLARI (f2Ud5tju) — nizo tekshiruvida "qaysi qurilmadan, qaysi
  // IP'dan" degan dalil. Nomlari ATAYLAB snake_case: ular aynan shu
  // ko'rinishda `activity_logs.metadata` ga tushadi (BeePost
  // `RequestContextStore` bilan bir xil kalitlar) va frontend chiplari shu
  // kalitlarni o'qiydi.
  //
  // Faqat gateway HTTP middleware'i to'ldiradi; RMQ orqali mikroservislarga
  // `x-audit-ctx` sarlavhasida yetib boradi (`rmq-context.serializer.ts`).
  // ⚠️ HTTP bo'lmagan oqimda (cron, bot, webhook) BO'SH — bu TO'G'RI, sun'iy
  // qiymat qo'yilmaydi.

  /** Haqiqiy mijoz IP'si (Cloudflare `CF-Connecting-IP`, bo'lmasa `req.ip`). */
  ip?: string;
  /** User-Agent — `AUDIT_CONTEXT_LIMITS.user_agent` belgigacha kesilgan. */
  user_agent?: string;
  /** Frontend yuboradigan barqaror qurilma ID si (`X-Device-Id`). */
  device_id?: string;
  /** "Telefon · Android · Chrome" (`X-Device-Name` yoki User-Agent'dan). */
  device_name?: string;
}

/** Kontekstdagi audit maydonlari (traceId/userId'siz) — metadata'ga tushadi. */
export type AuditContext = Pick<
  RequestContextStore,
  'ip' | 'user_agent' | 'device_id' | 'device_name'
>;

/**
 * Har bir audit maydonining maksimal uzunligi (f2Ud5tju). User-Agent
 * cheklanmasa har RMQ xabari va har jurnal qatori bir necha KB ga shishardi
 * (ba'zi botlar 1-2 KB lik UA yuboradi).
 */
export const AUDIT_CONTEXT_LIMITS: Readonly<
  Record<keyof AuditContext, number>
> = Object.freeze({
  ip: 64,
  user_agent: 256,
  device_id: 128,
  device_name: 128,
});

const AUDIT_CONTEXT_KEYS = Object.keys(AUDIT_CONTEXT_LIMITS) as Array<
  keyof AuditContext
>;

/**
 * Ishonchsiz manbadan (HTTP sarlavha, RMQ sarlavha) kelgan audit maydonlarini
 * tozalaydi: faqat satr, boshqaruv belgilarisiz, bo'sh emas va
 * `AUDIT_CONTEXT_LIMITS` gacha kesilgan. Natijada faqat ANIQLANGAN kalitlar
 * qoladi — bo'sh obyekt "kontekst yo'q" degani.
 */
export function sanitizeAuditContext(raw: unknown): AuditContext {
  const out: AuditContext = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of AUDIT_CONTEXT_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (clean) out[key] = clean.slice(0, AUDIT_CONTEXT_LIMITS[key]);
  }
  return out;
}

/** Store'dan faqat audit maydonlarini (aniqlanganlarini) ajratadi. */
export function pickAuditContext(
  store: RequestContextStore | undefined,
): AuditContext {
  return store ? sanitizeAuditContext(store) : {};
}

/**
 * Process-wide correlation store. Set at the entry boundary (gateway HTTP
 * middleware, RMQ message interceptor) and read everywhere else: log mixin,
 * outgoing RMQ payload, Sentry tags, etc.
 *
 * AsyncLocalStorage transparently follows Promise chains, so a value set in
 * a middleware survives async hops inside that request.
 */
class RequestContext {
  private readonly als = new AsyncLocalStorage<RequestContextStore>();

  /** Run `fn` inside a fresh context. */
  run<T>(store: RequestContextStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  /** Current store, or undefined if called outside any request. */
  get(): RequestContextStore | undefined {
    return this.als.getStore();
  }

  getTraceId(): string | undefined {
    return this.als.getStore()?.traceId;
  }

  /**
   * Joriy so'rovning audit maydonlari (f2Ud5tju) — HTTP konteksti bo'lmasa
   * `{}` (cron/bot/webhook).
   */
  getAuditContext(): AuditContext {
    return pickAuditContext(this.als.getStore());
  }

  /** Generate a new trace id; useful for callers that may need to root one. */
  static newTraceId(): string {
    return randomUUID();
  }
}

export const requestContext = new RequestContext();
