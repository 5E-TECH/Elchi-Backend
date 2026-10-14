import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContextStore {
  traceId: string;
  /** Optional user id when known (gateway extracts from JWT). */
  userId?: string;
  /**
   * (fQi6NNUL / y8CxCtcK) Aktyorning ismi va roli — AMAL PAYTIDAGI holat.
   * Gateway JWT tekshiruvidan keyin qo'yadi (`requestContext.setActor`),
   * RMQ orqali `x-audit-actor` sarlavhasida servislarga boradi va
   * `ActivityLogService.log()` ularni `user_name` / `user_role` ustunlariga
   * yozadi (enrichment'siz ham "Kim" ustuni ismli; keyin rol o'zgarsa ham
   * eski qator o'zgarmaydi). Metadata'ga TUSHMAYDI (`AuditContext` emas).
   */
  userName?: string;
  userRole?: string;
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

/** (fQi6NNUL) Kontekstdagi aktyor — `activity_logs.user_*` ustunlari bilan mos chegaralar. */
export interface AuditActor {
  userId?: string;
  userName?: string;
  userRole?: string;
}

export const AUDIT_ACTOR_LIMITS = Object.freeze({
  userId: 100,
  userName: 200,
  userRole: 32,
});

const ACTOR_ID_RE = /^[A-Za-z0-9:._-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

function cleanActorText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const clean = String(value).replace(CONTROL_CHARS_RE, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

/**
 * Ishonchsiz manbadan (JWT payload, RMQ sarlavha) kelgan aktyorni tozalaydi:
 * id — faqat `[A-Za-z0-9:._-]` (100 gacha), ism — boshqaruv belgilarisiz
 * (200 gacha), rol — kichik harf (32 gacha). Noto'g'ri qiymat tashlanadi.
 */
export function sanitizeAuditActor(raw: unknown): AuditActor {
  const out: AuditActor = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  const id = cleanActorText(source.userId, AUDIT_ACTOR_LIMITS.userId + 1);
  if (id && id.length <= AUDIT_ACTOR_LIMITS.userId && ACTOR_ID_RE.test(id)) {
    out.userId = id;
  }
  const name = cleanActorText(source.userName, AUDIT_ACTOR_LIMITS.userName);
  if (name) out.userName = name;
  const role = cleanActorText(source.userRole, AUDIT_ACTOR_LIMITS.userRole);
  if (role) out.userRole = role.toLowerCase();
  return out;
}

/** Store'dan faqat aktyor maydonlarini (aniqlanganlarini) ajratadi. */
export function pickAuditActor(
  store: RequestContextStore | undefined,
): AuditActor {
  return store ? sanitizeAuditActor(store) : {};
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

  /**
   * (fQi6NNUL) Joriy so'rov aktyorini qo'yadi — gateway JWT tekshiruvidan
   * keyin (`JwtStrategy.validate`). Middleware JWT'dan OLDIN ishlaydi,
   * shuning uchun do'kon shu yerda to'ldiriladi (AYNI obyekt — so'rovning
   * keyingi barcha async qadamlari ko'radi). Kontekst yo'q bo'lsa — no-op.
   */
  setActor(actor: AuditActor): void {
    const store = this.als.getStore();
    if (!store) return;
    const clean = sanitizeAuditActor(actor);
    store.userId = clean.userId;
    store.userName = clean.userName;
    store.userRole = clean.userRole;
  }

  /** Generate a new trace id; useful for callers that may need to root one. */
  static newTraceId(): string {
    return randomUUID();
  }
}

export const requestContext = new RequestContext();
