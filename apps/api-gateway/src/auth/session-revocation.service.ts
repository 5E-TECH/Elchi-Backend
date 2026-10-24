import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

/** identity-service ichki pattern'i: `{ userId, sessionId }` → `{ active }`. */
export const SESSION_STATE_PATTERN = {
  cmd: 'identity.auth.session_state',
} as const;

/** Ochiq sessiya shuncha vaqtdan keyin identity'dan qayta so'raladi. */
export const SESSION_ACTIVE_RECHECK_MS = 30_000;
/** identity javob bermasa — «noma'lum» (ruxsat) natija shuncha saqlanadi. */
export const SESSION_UNKNOWN_TTL_MS = 5_000;
/** identity'ga so'rov chegarasi — so'rov yo'lida turadi, qisqa bo'lishi shart. */
export const SESSION_STATE_TIMEOUT_MS = 1_500;
/** Kesh hajmi chegarasi (eng eskisi chiqariladi). */
export const SESSION_CACHE_MAX = 10_000;
/** Fail-open ogohlantirishi ko'pi bilan shuncha vaqtda bir marta. */
const FAIL_OPEN_WARN_INTERVAL_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

type SessionState = 'active' | 'revoked' | 'unknown';

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * (Elchi Pochta #3) Access token `sid` claim'i sessiya id si (UUID) bo'lsa —
 * kichik harfda; aks holda `null` (Telegram Mini App, bot aktori, eski
 * token — sessiya emas, tekshirilmaydi). HTTP (`JwtStrategy`) va socket
 * (`RealtimeGateway`) bir xil qoida bilan.
 */
export function sessionIdClaim(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
    ? value.toLowerCase()
    : null;
}

/**
 * (Elchi Pochta #3, 2026-10-24) Sessiya nega yopildi — socket
 * `auth:session_revoked` hodisasining `reason` i:
 *  - `revoked_by_owner` — egasi «Sessiyalar» bo'limidan chiqardi (bittasini
 *    yoki «Boshqa barcha qurilmalardan chiqish»);
 *  - `password_changed` — parol almashtirildi (o'zi yoki admin tikladi);
 *  - `logout` — shu sessiyaning o'zi «Chiqish» qildi (boshqa tablari ham
 *    chiqadi);
 *  - `security_reset` — identity yopdi (xavfsizlik hodisasi: epoch, soatlik
 *    tozalash).
 */
export const SESSION_KICK_REASONS = [
  'revoked_by_owner',
  'password_changed',
  'logout',
  'security_reset',
] as const;
export type SessionKickReason = (typeof SESSION_KICK_REASONS)[number];

export function isSessionKickReason(
  value: unknown,
): value is SessionKickReason {
  return (
    typeof value === 'string' &&
    (SESSION_KICK_REASONS as readonly string[]).includes(value)
  );
}

/** Yopilgan sessiyalar tinglovchisi (socket qismi — `RealtimeGateway`). */
export type SessionKickListener = (
  sessionIds: string[],
  reason: SessionKickReason,
) => void;

interface CacheEntry {
  state: SessionState;
  until: number;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `ACCESS_TOKEN_TIME` (JwtModule `expiresIn`) → ms: `'1h'`, `'30m'`,
 * `'3600'` (soniya, jsonwebtoken kabi). Tushunilmasa — sukut (1 soat).
 */
export function accessTokenTtlMs(raw: string | number | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw * 1000;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(
    String(raw ?? ''),
  );
  if (!match) return DEFAULT_ACCESS_TOKEN_TTL_MS;
  const value =
    Number(match[1]) * DURATION_UNIT_MS[(match[2] ?? 's').toLowerCase()];
  return value > 0 ? value : DEFAULT_ACCESS_TOKEN_TTL_MS;
}

/**
 * (Elchi Pochta #3, 2026-10-23) Parol almashgan `identity.user.update` /
 * `identity.market.update` javobi: ichki `revoked_session_ids` shu gateway
 * keshida darhol «yopilgan» deb belgilanadi va javobdan OLIB TASHLANADI
 * (admin boshqa odamning sessiya id larini ko'rmaydi; FE uchun
 * `sessions_revoked` soni qoladi). Maydon bo'lmasa — javob o'zgarmaydi.
 */
export function applyRevokedSessionIds<T>(
  response: T,
  revocation?: Pick<SessionRevocationService, 'kickSessions'> | null,
): T {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  const record = response as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'revoked_session_ids')) {
    return response;
  }
  const { revoked_session_ids: ids, ...rest } = record;
  // (2026-10-24) Belgilash + o'sha qurilmalarning socketlari darhol
  // `auth:session_revoked` (`password_changed`) olib uziladi.
  if (Array.isArray(ids)) revocation?.kickSessions(ids, 'password_changed');
  return rest as T;
}

/**
 * (Elchi Pochta #3) Yopilgan sessiya access tokenini DARHOL to'xtatish.
 *
 * Access token stateless (1 soat). Egasi «Sessiyalar» bo'limidan boshqa
 * qurilmani chiqarganda (yoki logout) o'sha qurilma tokeni muddati
 * tugashini kutmay to'xtashi kerak. `JwtStrategy.validate` `sid` li har
 * token uchun shu servisni so'raydi:
 *
 *  - xotiradagi kesh `sid → holat`: ochiq sessiya 30 soniyadan keyin qayta
 *    tekshiriladi; yopilgani ACCESS_TOKEN_TIME (o'sha sessiyaning eng oxirgi
 *    tokeni ham shu vaqtda o'ladi) saqlanadi, keyin chiqariladi; hajm
 *    10 000 bilan chegaralangan (eng eskisi chiqadi — keyingi so'rov identity'dan
 *    qayta oladi, xavfsizlik buzilmaydi);
 *  - keshda yo'q bo'lsa — identity `identity.auth.session_state` (1,5 s).
 *    Bir vaqtdagi bir xil `sid` so'rovlari bitta RMQ chaqiruvini kutadi;
 *  - identity javob bermasa / xato — FAIL OPEN: ruxsat beriladi (identity
 *    uzilishi hammani chiqarib yubormasin), ogohlantirish daqiqasiga bir
 *    marta, natija 5 soniya saqlanadi;
 *  - revoke endpointlari, logout va parol almashtirish (`PATCH
 *    /auth/my-profile`, `PATCH /users/:id`) identity tasdiqlagan id larni
 *    `markRevoked` bilan darhol belgilaydi (shu gateway instansida kutish
 *    yo'q; boshqa instansda ≤ 30 soniya).
 *
 * `sid` siz tokenlar (Telegram Mini App, bot aktori, deploy'dan oldingi)
 * bu yerga kelmaydi — ular sessiya emas.
 *
 * (2026-10-24) `kickSessions` — gateway yopilgan sessiya id larini qayerdan
 * bilmasin (revoke endpointlari, logout, parol almashtirish, identity'ning
 * `auth.sessions.kick` xabari) YAGONA kirish nuqtasi: keshda «yopilgan» +
 * tinglovchilar (`RealtimeGateway` — o'sha sessiya socketlariga
 * `auth:session_revoked`, keyin uzish). Qurilma keyingi HTTP so'rovini
 * kutmay shu zahoti login sahifasiga chiqadi.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<SessionState>>();
  private readonly kickListeners = new Set<SessionKickListener>();
  private readonly revokedTtlMs: number;
  private lastWarnAt = 0;
  private suppressedWarnings = 0;

  /** Soat — spec'lar vaqtni boshqarishi uchun. */
  now: () => number = () => Date.now();

  constructor(
    @Inject('IDENTITY') private readonly identity: ClientProxy,
    @Optional() config?: ConfigService,
  ) {
    this.revokedTtlMs = accessTokenTtlMs(
      config?.get<string>('ACCESS_TOKEN_TIME'),
    );
  }

  /**
   * `true` — sessiya aniq yopilgan (token rad etiladi). identity'ga yetib
   * bo'lmasa `false` (fail open).
   */
  async isRevoked(userId: string, sessionId: string): Promise<boolean> {
    const key = sessionId.toLowerCase();
    const cached = this.read(key);
    if (cached !== null) return cached === 'revoked';

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.lookup(userId, key).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return (await pending) === 'revoked';
  }

  /** identity tasdiqlagan yopilgan sessiyalar — shu instansda darhol 401. */
  markRevoked(sessionIds: Iterable<unknown> | null | undefined): void {
    for (const id of sessionIds ?? []) {
      if (typeof id === 'string' && id) {
        this.write(id.toLowerCase(), 'revoked');
      }
    }
  }

  /**
   * (Elchi Pochta #3, 2026-10-24) Yopilgan sessiyalarni SHU ZAHOTI
   * chiqarish: har biri keshda «yopilgan» (keyingi HTTP so'rov 401, socket
   * qayta ulanishi rad etiladi), keyin tinglovchilar (socketlarga
   * `auth:session_revoked` + uzish). Faqat UUID ko'rinishidagi id lar
   * (kichik harfda, takrorsiz); qaytadi — shu id lar. Tinglovchi xatosi
   * chaqiruvchiga (HTTP javobi) TA'SIR QILMAYDI — faqat ogohlantirish.
   */
  kickSessions(
    sessionIds: Iterable<unknown> | null | undefined,
    reason: SessionKickReason,
  ): string[] {
    const ids = [
      ...new Set(
        [...(sessionIds ?? [])]
          .map((id) => sessionIdClaim(id))
          .filter((id): id is string => id !== null),
      ),
    ];
    if (!ids.length) return [];
    this.markRevoked(ids);
    for (const listener of this.kickListeners) {
      try {
        listener(ids, reason);
      } catch (error) {
        this.logger.warn(
          `Sessiya socketlarini uzib bo'lmadi (${reason}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return ids;
  }

  /** `kickSessions` tinglovchisi; qaytadi — obunani bekor qilish. */
  onKick(listener: SessionKickListener): () => void {
    this.kickListeners.add(listener);
    return () => {
      this.kickListeners.delete(listener);
    };
  }

  /** Kuzatuv/spec uchun: keshdagi yozuvlar soni. */
  get size(): number {
    return this.cache.size;
  }

  private read(key: string): SessionState | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.until <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.state;
  }

  private write(key: string, state: SessionState): void {
    const ttl =
      state === 'revoked'
        ? this.revokedTtlMs
        : state === 'active'
          ? SESSION_ACTIVE_RECHECK_MS
          : SESSION_UNKNOWN_TTL_MS;
    // Qayta qo'yish — Map tartibida oxirga o'tadi (eng eskisi birinchi chiqadi).
    this.cache.delete(key);
    this.cache.set(key, { state, until: this.now() + ttl });
    while (this.cache.size > SESSION_CACHE_MAX) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private async lookup(userId: string, key: string): Promise<SessionState> {
    let state: SessionState;
    try {
      const reply = await rmqSend<{ active?: unknown }>(
        this.identity,
        SESSION_STATE_PATTERN,
        { userId, sessionId: key },
        {
          timeoutMs: SESSION_STATE_TIMEOUT_MS,
          retries: 0,
          attachRequestId: false,
        },
      );
      if (typeof reply?.active !== 'boolean') {
        throw new Error('unexpected session_state reply');
      }
      state = reply.active ? 'active' : 'revoked';
    } catch (error) {
      state = 'unknown';
      this.warnFailOpen(error);
    }
    // So'rov davomida revoke endpointi belgilagan bo'lsa — «yopilgan» ustun.
    if (this.read(key) === 'revoked') return 'revoked';
    this.write(key, state);
    return state;
  }

  private warnFailOpen(error: unknown): void {
    const now = this.now();
    if (now - this.lastWarnAt < FAIL_OPEN_WARN_INTERVAL_MS) {
      this.suppressedWarnings += 1;
      return;
    }
    const suppressed = this.suppressedWarnings;
    this.lastWarnAt = now;
    this.suppressedWarnings = 0;
    const message = (error as { message?: unknown } | null)?.message;
    const reason =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof message === 'string'
          ? message
          : 'unknown';
    this.logger.warn(
      `Sessiya holati tekshirilmadi (identity.auth.session_state) — ruxsat berildi (fail open): ${reason}${
        suppressed ? `; oldingi daqiqada yana ${suppressed} marta` : ''
      }`,
    );
  }
}
