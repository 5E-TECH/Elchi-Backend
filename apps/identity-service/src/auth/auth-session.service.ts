import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Between,
  EntityManager,
  FindOptionsOrder,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Status, requestContext } from '@app/common';
import { User } from '../entities/user.entity';
import {
  UserSession,
  UserSessionMethod,
  UserSessionRevokeReason,
} from '../entities/user-session.entity';
import {
  hashRefreshToken,
  isReusableDeviceId,
  isSessionId,
  passwordFingerprint,
} from './session-security';
import { SessionKickPublisher } from './session-kick.publisher';

export {
  hashRefreshToken,
  invalidateAllSessions,
  isReusableDeviceId,
  isSessionId,
  passwordFingerprint,
} from './session-security';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 1000;

/**
 * Muddati o'tgan / yopilgan sessiya qatori `expires_at` dan keyin shuncha
 * kun saqlanadi, keyin soatlik tozalash o'chiradi. (Elchi Pochta #3,
 * 2026-10-23) 90 kun: muddati o'tgan, lekin yopilmagan qator — foydalanuvchi
 * qurilmasi; u «Sessiyalar» ro'yxatida «Qayta kirish kerak» bo'lib turadi va
 * shu qurilma qayta kirsa AYNI qator yangilanadi.
 */
export const SESSION_RETENTION_DAYS = 90;

/** Ro'yxatda ko'pi bilan shuncha sessiya qaytadi (`active_count` — barcha faollar soni). */
export const SESSION_LIST_LIMIT = 50;

/** Ikki tab bir vaqtda kirganda INSERT/UPDATE poygasi uchun urinishlar soni. */
const OPEN_ATTEMPTS = 3;

/** Sessiya nega yaroqsiz (`null` — yaroqli). */
export type SessionRejectReason =
  | 'foreign'
  | 'revoked'
  | 'reset'
  | 'password_changed'
  | 'expired';

/**
 * Ro'yxatdagi sessiya holati: `active` — refresh muddati o'tmagan va parol
 * o'sha (ishlayapti); `expired` — muddati o'tgan yoki parol almashgan, lekin
 * qurilma chiqmagan — UI'da «Qayta kirish kerak» (shu qurilmadan login AYNI
 * sessiyani tiklaydi).
 */
export type OwnSessionStatus = 'active' | 'expired';

/** `GET /auth/sessions` qatori — faqat egasiga. Token/hash/epoch CHIQMAYDI. */
export interface OwnSessionView {
  id: string;
  status: OwnSessionStatus;
  device_name: string | null;
  device_id: string | null;
  user_agent: string | null;
  ip: string | null;
  /** Shu qurilmadan birinchi login (`created_at`). */
  first_logged_in_at: string;
  /** Oxirgi login (`last_login_at`) — qayta kirishda yangilanadi. */
  logged_in_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

export interface OwnSessionsList {
  /** Faqat `status: 'active'` sessiyalar soni (ro'yxat chegarasidan qat'i nazar). */
  active_count: number;
  sessions: OwnSessionView[];
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string })?.code === '23505';

/** `UPDATE … RETURNING "id"` natijasidagi id lar (kichik harf). */
function returnedIds(result: unknown): string[] {
  // Postgres drayveri UPDATE uchun `[rows, rowCount]` qaytaradi.
  const rows =
    Array.isArray(result) && Array.isArray(result[0])
      ? (result[0] as Array<{ id?: unknown }>)
      : [];
  return rows
    .map((row) => (typeof row.id === 'string' ? row.id.toLowerCase() : ''))
    .filter(Boolean);
}

/**
 * Parol almashgandan keyingi natija (`afterPasswordChange`): yopilgan
 * sessiyalar va joriy sessiya saqlandimi.
 */
export interface PasswordChangeSessions {
  /** `password_changed` bilan HOZIR yopilgan sessiyalar (gateway keshi uchun). */
  session_ids: string[];
  /** Saqlangan (parol izi yangilangan) joriy sessiya; yo'q bo'lsa `null`. */
  kept_session_id: string | null;
}

/**
 * (Elchi Pochta #3 — "Sessionlar bo'limi") Har QURILMA uchun bitta sessiya
 * (qurilma ID siz — har login uchun alohida): ochish yoki shu qurilmaning
 * yopilmagan sessiyasini qayta ishlatish, refresh'da tekshirish, logout'da
 * faqat joriy sessiyani yopish, egasiga o'z sessiyalari ro'yxati (faol va
 * «Qayta kirish kerak»), egasi boshqa sessiyalarini yopishi (bittasini yoki
 * joriydan boshqa hammasini) va soatlik tozalash.
 *
 * Telegram Mini App (`POST /auth/telegram`) va bot aktori tokenlari bu yerga
 * TUSHMAYDI: ular refresh'siz, qisqa (30 daqiqa) access token — brauzer
 * sessiyasi emas, ro'yxatda ham ko'rinmaydi.
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    @InjectRepository(UserSession)
    private readonly sessions: Repository<UserSession>,
    /**
     * (Elchi Pochta #3, 2026-10-24) gateway so'rov yo'lidan tashqarida
     * `security_reset` bilan yopilgan sessiyalarni gateway'ga e'lon qiladi
     * (socketlari darhol uziladi). Ixtiyoriy — spec'lar servisni usiz quradi.
     */
    @Optional() private readonly kicks?: SessionKickPublisher,
  ) {}

  /** `security_reset` bilan yopilganlar — gateway socketlarini uzadi. */
  private announceSecurityReset(sessionIds: string[]): void {
    if (sessionIds.length) this.kicks?.publish(sessionIds, 'security_reset');
  }

  private build(input: {
    user: User;
    refreshToken: string;
    expiresAt: Date;
    method: UserSessionMethod;
    createdAt?: Date;
    now: Date;
  }): UserSession {
    // Gateway middleware'i yig'gan kontekst (RMQ `x-audit-ctx` orqali):
    // CF-Connecting-IP, User-Agent (≤256), X-Device-Id, X-Device-Name yoki
    // UA'dan "Telefon · Android · Chrome". HTTP bo'lmasa — bo'sh.
    const audit = requestContext.getAuditContext();
    const loggedInAt = input.createdAt ?? input.now;
    return this.sessions.create({
      id: randomUUID(),
      user_id: String(input.user.id),
      refresh_token_hash: hashRefreshToken(input.refreshToken),
      epoch: Number(input.user.session_epoch) || 0,
      password_fp: passwordFingerprint(input.user.password),
      method: input.method,
      created_at: loggedInAt,
      last_login_at: loggedInAt,
      last_seen_at: input.now,
      expires_at: input.expiresAt,
      revoked_at: null,
      revoke_reason: null,
      // Faqat yaroqli shakl — qurilma kaliti (`UQ_USER_SESSIONS_USER_DEVICE_OPEN`).
      device_id: isReusableDeviceId(audit.device_id) ? audit.device_id : null,
      device_name: audit.device_name ?? null,
      user_agent: audit.user_agent ?? null,
      ip: audit.ip ?? null,
    });
  }

  /**
   * Login → sessiya. Foydalanuvchining BOSHQA qurilmalaridagi sessiyalariga
   * TEGILMAYDI (bir nechta qurilmadan bir vaqtda kirish mumkin).
   *
   * "Telegram'dagidek" (Elchi Pochta #3, 2026-10-23): so'rovda yaroqli
   * `device_id` bo'lsa va shu foydalanuvchining shu qurilmadagi sessiyasi
   * aniq YOPILMAGAN bo'lsa (`revoked_at IS NULL` va `epoch` joriy) — yangi
   * qator ochilmaydi, o'sha qator yangilanadi (`reuseDeviceSession`).
   * Muddati o'tgan yoki parol barmoq izi eskirgan qator ham qayta
   * ishlatiladi; logout / egasi yopgan / xavfsizlik hodisasi — yo'q.
   * `device_id` siz login — har doim yangi qator (avvalgi xulq).
   *
   * Poyga (bir qurilmadan ikki tab bir vaqtda): ikkalasi ham qator topmay
   * INSERT qilsa, ikkinchisi `UQ_USER_SESSIONS_USER_DEVICE_OPEN` ga uriladi
   * (23505) va qaytadan urinib, birinchisi ochgan qatorni yangilaydi —
   * qurilmada doim BITTA ochiq qator. Qatorda oxirgi yozgan tabning tokeni
   * qoladi (cookie ham brauzerda bitta — odatda oxirgi javobniki).
   */
  async open(input: {
    user: User;
    refreshToken: string;
    expiresAt: Date;
    method: Exclude<UserSessionMethod, 'legacy'>;
    now?: Date;
  }): Promise<UserSession> {
    const now = input.now ?? new Date();
    const row = this.build({ ...input, now });
    if (!row.device_id) {
      await this.sessions.insert(row);
      return row;
    }
    for (let attempt = 1; ; attempt += 1) {
      const reused = await this.reuseDeviceSession(row, now);
      if (reused) return reused;
      try {
        await this.sessions.insert(row);
        return row;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= OPEN_ATTEMPTS) throw error;
        // Shu qurilmaning qatorini parallel login bizdan oldin ochdi —
        // keyingi aylanishda o'sha qator yangilanadi.
      }
    }
  }

  /**
   * Shu qurilmaning (`user_id` + `device_id`) ochiq qatori bo'lsa — yangi
   * login bilan yangilaydi va qaytaradi; bo'lmasa `null` (chaqiruvchi
   * INSERT qiladi).
   *
   * - `epoch` i eskirgan ochiq qator (xavfsizlik hodisasidan keyin, soatlik
   *   tozalash hali belgilamagan) — QAYTA ISHLATILMAYDI: avval
   *   `security_reset` bilan yopiladi (UNIQUE indeksni band qilmasin), keyin
   *   `null` → yangi qator.
   * - Yangilanadi: refresh hashi, muddati, epoch, parol izi, usul,
   *   `last_login_at` / `last_seen_at`, qurilma nomi, UA, IP. `id` (access
   *   token `sid`) va `created_at` (birinchi login) O'ZGARMAYDI — eski
   *   refresh token endi bu qatorga mos kelmaydi (401).
   * - UPDATE sharti `revoked_at IS NULL` va `epoch` joriy: shu orada
   *   yopilgan qator tirilmaydi (`null` → yangi qator).
   */
  private async reuseDeviceSession(
    fresh: UserSession,
    now: Date,
  ): Promise<UserSession | null> {
    const existing = await this.sessions.findOne({
      where: {
        user_id: fresh.user_id,
        device_id: fresh.device_id as string,
        revoked_at: IsNull(),
      },
    });
    if (!existing) return null;

    if ((Number(existing.epoch) || 0) !== fresh.epoch) {
      const reset = await this.sessions.update(
        { id: existing.id, revoked_at: IsNull() },
        { revoked_at: now, revoke_reason: 'security_reset' },
      );
      // Shu qurilmaning eski tokenli boshqa tablari socketdan ham chiqadi.
      if ((reset?.affected ?? 0) > 0) {
        this.announceSecurityReset([String(existing.id).toLowerCase()]);
      }
      return null;
    }

    const patch = {
      refresh_token_hash: fresh.refresh_token_hash,
      expires_at: fresh.expires_at,
      epoch: fresh.epoch,
      password_fp: fresh.password_fp,
      method: fresh.method,
      last_login_at: now,
      last_seen_at: now,
      device_name: fresh.device_name,
      user_agent: fresh.user_agent,
      ip: fresh.ip,
    };
    const result = await this.sessions.update(
      {
        id: existing.id,
        user_id: fresh.user_id,
        revoked_at: IsNull(),
        epoch: fresh.epoch,
      },
      patch,
    );
    if (!result.affected) return null;
    return this.sessions.create({ ...existing, ...patch });
  }

  /**
   * Deploy'dan OLDIN kirgan foydalanuvchi: refresh tokeni `admins.refresh_token`
   * hashiga mos, lekin sessiya qatori yo'q. Birinchi refresh'da qator
   * yaratiladi (login vaqti — eski JWT'ning `iat` i, muddati — `exp`) va
   * keyin u oddiy sessiya. Hech kim chiqarib yuborilmaydi.
   *
   * Ikki tab bir vaqtda refresh qilsa ikkinchi INSERT UNIQUE'ga uriladi —
   * u holda birinchisi yaratgan qator qaytadi. Shu qurilmada (`device_id`)
   * allaqachon ochiq qator bo'lsa INSERT `UQ_USER_SESSIONS_USER_DEVICE_OPEN`
   * ga uriladi — u holda o'sha qurilma qatori qaytadi (bitta qurilma —
   * bitta sessiya; uning yaroqliligini `rejectReason` baribir tekshiradi).
   */
  async adoptLegacy(input: {
    user: User;
    refreshToken: string;
    expiresAt: Date;
    createdAt?: Date;
    now?: Date;
  }): Promise<UserSession | null> {
    const row = this.build({
      ...input,
      method: 'legacy',
      now: input.now ?? new Date(),
    });
    try {
      await this.sessions.insert(row);
      return row;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const sameToken = await this.findByHash(row.refresh_token_hash);
      if (sameToken || !row.device_id) return sameToken;
      return this.sessions.findOne({
        where: {
          user_id: row.user_id,
          device_id: row.device_id,
          revoked_at: IsNull(),
        },
      });
    }
  }

  /**
   * (NDmZMzCP) Parol qayta xeshlandi (bcrypt 10 → 12, parolning o'zi
   * o'zgarmagan): shu foydalanuvchining eski xeshdan olingan parol izi
   * (`password_fp`) yangisiga ko'chiriladi — AYNI tranzaksiyada, aks holda
   * boshqa qurilmalar refresh'da «parol almashdi» deb chiqib ketardi.
   */
  async repointPasswordFingerprint(
    manager: EntityManager,
    userId: string,
    oldHash: string,
    newHash: string,
  ): Promise<number> {
    const result = await manager.update(
      UserSession,
      { user_id: String(userId), password_fp: passwordFingerprint(oldHash) },
      { password_fp: passwordFingerprint(newHash) },
    );
    return result.affected ?? 0;
  }

  /**
   * (NDmZMzCP) Login qulfi uchun: shu qurilma (`X-Device-Id`) yoki IP'dan
   * shu foydalanuvchi ilgari kirganmi (`user_sessions` da qator bor —
   * yopilgani ham). Tanish qurilma telefonning UMUMIY qulfini chetlab
   * o'tadi (hujumchi boshqa IP'lardan urinib egasini chiqarib qo'ya olmasin).
   * Xato — `false` (qulf amal qiladi).
   */
  async isKnownDevice(
    userId: string,
    input: { deviceId?: string | null; ip?: string | null },
  ): Promise<boolean> {
    const where: Array<Record<string, unknown>> = [];
    if (isReusableDeviceId(input.deviceId)) {
      where.push({ user_id: String(userId), device_id: input.deviceId });
    }
    if (input.ip) where.push({ user_id: String(userId), ip: input.ip });
    if (!where.length || !/^\d+$/.test(String(userId))) return false;
    try {
      return (await this.sessions.count({ where, take: 1 })) > 0;
    } catch {
      return false;
    }
  }

  findByHash(refreshTokenHash: string): Promise<UserSession | null> {
    return this.sessions.findOne({
      where: { refresh_token_hash: refreshTokenHash },
    });
  }

  /**
   * Sessiya shu foydalanuvchi uchun hozir yaroqlimi. Tartib: begona →
   * yopilgan → xavfsizlik hodisasi (epoch) → parol almashgan → muddati.
   */
  rejectReason(
    session: UserSession,
    user: User,
    now = new Date(),
  ): SessionRejectReason | null {
    if (String(session.user_id) !== String(user.id)) return 'foreign';
    if (session.revoked_at) return 'revoked';
    if ((Number(session.epoch) || 0) !== (Number(user.session_epoch) || 0)) {
      return 'reset';
    }
    if (session.password_fp !== passwordFingerprint(user.password)) {
      return 'password_changed';
    }
    if (new Date(session.expires_at).getTime() <= now.getTime()) {
      return 'expired';
    }
    return null;
  }

  /**
   * Muvaffaqiyatli refresh → `last_seen_at`. Shart `revoked_at IS NULL`:
   * logout bilan poyga bo'lsa (yopilgan sessiya) `false` — token berilmaydi.
   */
  async touch(sessionId: string, now = new Date()): Promise<boolean> {
    const result = await this.sessions.update(
      { id: sessionId, revoked_at: IsNull() },
      { last_seen_at: now },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Shu foydalanuvchining ochiq sessiyasini yopadi — id (access token
   * `sid`) va/yoki refresh token hashi bo'yicha. `user_id` sharti majburiy:
   * boshqa odamning sessiyasini hech qanday id bilan yopib bo'lmaydi.
   */
  async revokeOwn(
    userId: string,
    target: { sessionId?: string | null; refreshTokenHash?: string | null },
    reason: UserSessionRevokeReason,
    now = new Date(),
  ): Promise<number> {
    const criteria: Array<Record<string, unknown>> = [];
    if (isSessionId(target.sessionId)) {
      criteria.push({ id: target.sessionId });
    }
    if (target.refreshTokenHash) {
      criteria.push({ refresh_token_hash: target.refreshTokenHash });
    }
    let revoked = 0;
    for (const where of criteria) {
      const result = await this.sessions.update(
        { ...where, user_id: String(userId), revoked_at: IsNull() },
        { revoked_at: now, revoke_reason: reason },
      );
      const affected = result?.affected ?? 0;
      revoked += affected;
      // (2026-10-24) Refresh'da aniqlangan xavfsizlik hodisasi — gateway
      // bilmaydi, e'lon qilinadi. `logout` ni gateway o'zi chiqaradi.
      if (reason === 'security_reset' && affected > 0 && 'id' in where) {
        this.announceSecurityReset([String(where.id).toLowerCase()]);
      }
    }
    return revoked;
  }

  /**
   * logout: id (access token `sid`) va/yoki refresh token hashi bo'yicha
   * topilgan, SHU foydalanuvchiga tegishli sessiyalar id lari (ochiq yoki
   * yopilganidan qat'i nazar). Begona qator hech qachon qaytmaydi.
   */
  async ownSessionIds(
    userId: string,
    target: { sessionId?: string | null; refreshTokenHash?: string | null },
  ): Promise<string[]> {
    const ids = new Set<string>();
    const lookups: Array<Record<string, unknown>> = [];
    if (isSessionId(target.sessionId)) {
      lookups.push({ id: target.sessionId.toLowerCase() });
    }
    if (target.refreshTokenHash) {
      lookups.push({ refresh_token_hash: target.refreshTokenHash });
    }
    for (const where of lookups) {
      const row = await this.sessions.findOne({
        select: ['id'],
        where: { ...where, user_id: String(userId) },
      });
      if (row) ids.add(String(row.id).toLowerCase());
    }
    return [...ids];
  }

  /**
   * «Sessiyalar» bo'limi: egasi BITTA sessiyasini (boshqa qurilma) id bo'yicha
   * yopadi. `user_id` va `revoked_at IS NULL` sharti — begona, yo'q yoki
   * allaqachon yopilgan sessiya → `[]` (chaqiruvchi 404 qaytaradi).
   * Muddati o'tgan («Qayta kirish kerak»), lekin yopilmagan qator ham
   * yopiladi — u ham egasining qurilmasi; yopilgach shu qurilma qayta
   * kirsa YANGI sessiya ochiladi.
   * Qaytadi — haqiqatan yopilgan sessiya id lari.
   */
  async revokeOwnById(
    userId: string,
    sessionId: string,
    reason: UserSessionRevokeReason,
    now = new Date(),
  ): Promise<string[]> {
    if (!isSessionId(sessionId)) return [];
    const id = sessionId.toLowerCase();
    const result = await this.sessions.update(
      { id, user_id: String(userId), revoked_at: IsNull() },
      { revoked_at: now, revoke_reason: reason },
    );
    return (result.affected ?? 0) > 0 ? [id] : [];
  }

  /**
   * «Boshqa sessiyalardan chiqish»: joriy sessiyadan (`keepSessionId`)
   * boshqa BARCHA ochiq sessiyalar — bitta atomar `UPDATE … RETURNING`.
   * Faqat SHU foydalanuvchiniki va faqat `revoked_at IS NULL` (avval
   * yopilganlarning vaqti/sababi o'zgarmaydi). Muddati o'tgan («Qayta
   * kirish kerak») yoki epoch'i eskirgan, lekin hali belgilanmagan qatorlar
   * ham yopiladi: ular ham egasining qurilmalari (aks holda o'sha qurilma
   * qayta kirib AYNI sessiyani tiklardi), oxirgi access tokeni esa
   * ACCESS_TOKEN_TIME gacha yashashi mumkin.
   */
  async revokeOwnExcept(
    userId: string,
    keepSessionId: string,
    reason: UserSessionRevokeReason,
    now = new Date(),
  ): Promise<string[]> {
    if (!isSessionId(keepSessionId)) return [];
    const result: unknown = await this.sessions.query(
      `UPDATE "identity_schema"."user_sessions"
          SET "revoked_at" = $1, "revoke_reason" = $2
        WHERE "user_id" = $3
          AND "revoked_at" IS NULL
          AND "id" <> $4
      RETURNING "id"`,
      [now, reason, String(userId), keepSessionId.toLowerCase()],
    );
    return returnedIds(result);
  }

  /**
   * Foydalanuvchining BARCHA ochiq sessiyalari (muddati o'tgan / epoch'i
   * eskirganlari ham) — bitta atomar `UPDATE … RETURNING`. Admin parolni
   * tiklaganda: qatorlar darhol yopiladi, gateway `session_state` ham
   * `active: false` qaytaradi (faqat epoch oshirish access tokenni 1 soatgacha
   * tirik qoldirardi).
   */
  async revokeAllOpen(
    userId: string,
    reason: UserSessionRevokeReason,
    now = new Date(),
  ): Promise<string[]> {
    if (!/^\d+$/.test(String(userId))) return [];
    const result: unknown = await this.sessions.query(
      `UPDATE "identity_schema"."user_sessions"
          SET "revoked_at" = $1, "revoke_reason" = $2
        WHERE "user_id" = $3
          AND "revoked_at" IS NULL
      RETURNING "id"`,
      [now, reason, String(userId)],
    );
    return returnedIds(result);
  }

  /**
   * (2026-10-23) Parol almashdi — sessiyalar DARHOL yopiladi (48 soatlik
   * qulfga bog'liq emas, bu yangi qurilma egasining «qochish yo'li»):
   *
   *  - `keepSessionId` (o'zi, `sid` li sessiyadan almashtirdi): avval joriy
   *    sessiyaning parol izi YANGI parolga yoziladi (aks holda keyingi
   *    refresh `password_changed` bilan rad etilib, joriy qurilma ham
   *    chiqib ketardi), keyin joriydan BOSHQA hammasi `password_changed`
   *    bilan yopiladi. Shart: qator SHU foydalanuvchiniki, ochiq va epoch'i
   *    joriy — aks holda (yopilgan / eskirgan) saqlanadigan sessiya yo'q →
   *    hammasi yopiladi;
   *  - `keepSessionId` yo'q (admin/menejer boshqa foydalanuvchi parolini
   *    tikladi, yoki `sid` siz token) — HAMMASI yopiladi.
   *
   * `user` — SAQLANGAN (yangi parol hashi bilan) foydalanuvchi. Yopilmay
   * qolgan qator bo'lsa ham (masalan, shu orada ochilgan) uning parol izi
   * eski — refresh baribir rad etadi.
   */
  async afterPasswordChange(input: {
    user: Pick<User, 'id' | 'password' | 'session_epoch'>;
    keepSessionId?: string | null;
    now?: Date;
  }): Promise<PasswordChangeSessions> {
    const now = input.now ?? new Date();
    const userId = String(input.user.id);
    const keep = isSessionId(input.keepSessionId)
      ? input.keepSessionId.toLowerCase()
      : null;

    if (keep) {
      const rebound = await this.sessions.update(
        {
          id: keep,
          user_id: userId,
          revoked_at: IsNull(),
          epoch: Number(input.user.session_epoch) || 0,
        },
        { password_fp: passwordFingerprint(input.user.password) },
      );
      if ((rebound.affected ?? 0) > 0) {
        return {
          session_ids: await this.revokeOwnExcept(
            userId,
            keep,
            'password_changed',
            now,
          ),
          kept_session_id: keep,
        };
      }
    }
    return {
      session_ids: await this.revokeAllOpen(userId, 'password_changed', now),
      kept_session_id: null,
    };
  }

  /**
   * Sessiya QATORI aniq yopilmaganmi: qator bor, SHU foydalanuvchiniki va
   * `revoked_at IS NULL` (logout, egasi yopgani yoki tozalash belgilagani
   * hisoblanadi) — bitta PK qidiruvi. Faqat qator darajasi: gateway
   * (`identity.auth.session_state`) endi `findOpenRow` + `isUsable` orqali
   * TO'LIQ tekshiradi (NDmZMzCP).
   */
  async isOpen(userId: string, sessionId: string): Promise<boolean> {
    return (await this.findOpen(userId, sessionId)) !== null;
  }

  /**
   * (NDmZMzCP) `isOpen` sharti (bitta PK qidiruvi), lekin to'liq qator —
   * `isUsable` uchun (epoch, parol izi). Noto'g'ri kirish — bazaga so'rovsiz
   * `null`.
   */
  async findOpenRow(
    userId: string,
    sessionId: string,
  ): Promise<UserSession | null> {
    if (!/^\d+$/.test(String(userId)) || !isSessionId(sessionId)) {
      return null;
    }
    return this.sessions.findOne({
      where: {
        id: sessionId.toLowerCase(),
        user_id: String(userId),
        revoked_at: IsNull(),
      },
    });
  }

  /**
   * (NDmZMzCP, 2026-10-26) Gateway `JwtStrategy` / socket har ~30 soniyada
   * so'raydigan TO'LIQ tekshiruv (`identity.auth.session_state`): access
   * token sessiyasi hozir yaroqlimi. Ilgari faqat `revoked_at` qaralardi —
   * bloklangan / roli yoki telefoni almashgan / o'chirilgan foydalanuvchi
   * access tokeni soatlik tozalashgacha (≤ 1 soat) ishlardi. Endi:
   *  - foydalanuvchi yo'q, o'chirilgan yoki `status != ACTIVE` → yopiq;
   *  - `rejectReason`: begona / yopilgan / `reset` (epoch — bloklash, rol,
   *    telefon, o'chirish) → yopiq. `reset` qatori shu zahoti
   *    `security_reset` bilan yopiladi va gateway'ga e'lon qilinadi (socketlar
   *    uziladi) — refresh'dagi bilan bir xil;
   *  - `expired` (refresh muddati) — OCHIQ, avvalgidek: access tokenning o'z
   *    `exp` i bor;
   *  - `password_changed` — bu yerda OCHIQ: parol almashtirish sessiyalarni
   *    allaqachon `revoked_at` bilan DARHOL yopadi (`afterPasswordChange`).
   *    Bu yerda rad etilsa, o'zi parolni almashtirganda saqlanadigan joriy
   *    sessiya (parol saqlangan, uning izi hali yangilanmagan millisoniyalar)
   *    chiqib ketishi mumkin edi. Refresh baribir parol izini tekshiradi.
   */
  async isUsable(
    session: UserSession,
    user: Pick<
      User,
      'id' | 'status' | 'isDeleted' | 'session_epoch' | 'password'
    > | null,
    now = new Date(),
  ): Promise<boolean> {
    if (!user || user.isDeleted || user.status !== Status.ACTIVE) return false;
    const reason = this.rejectReason(session, user as User, now);
    if (
      reason === null ||
      reason === 'expired' ||
      reason === 'password_changed'
    ) {
      return true;
    }
    if (reason === 'reset') {
      await this.revokeOwn(
        String(user.id),
        { sessionId: session.id },
        'security_reset',
        now,
      );
    }
    return false;
  }

  /**
   * (NDmZMzCP) Xavfsizlik hodisasidan (bloklash, rol / telefon almashishi,
   * o'chirish — `invalidateAllSessions`) KEYIN, saqlangan zahoti: SHU
   * foydalanuvchining epoch'i eskirgan ochiq qatorlari `security_reset` bilan
   * yopiladi va gateway'ga e'lon qilinadi (`auth.sessions.kick` — keshda
   * «yopilgan» + socketlar `auth:session_revoked` olib uziladi). Soatlik
   * tozalashning 1-qadami, faqat bitta foydalanuvchi uchun. Qaytadi —
   * yopilgan id lar.
   */
  async revokeStaleEpoch(userId: string, now = new Date()): Promise<string[]> {
    if (!/^\d+$/.test(String(userId))) return [];
    const result: unknown = await this.sessions.query(
      `UPDATE "identity_schema"."user_sessions" s
          SET "revoked_at" = $1, "revoke_reason" = 'security_reset'
         FROM "identity_schema"."admins" a
        WHERE a."id" = s."user_id"
          AND s."user_id" = $2
          AND s."revoked_at" IS NULL
          AND s."epoch" <> a."session_epoch"
      RETURNING s."id"`,
      [now, String(userId)],
    );
    const ids = returnedIds(result);
    this.announceSecurityReset(ids);
    return ids;
  }

  /**
   * `isOpen` bilan bir xil shart (bitta PK qidiruvi), lekin qatorning
   * `created_at` i ham qaytadi — sessiyalarni boshqarishda 48 soatlik qulf
   * shu bo'yicha (`sessionRevokeLock`).
   */
  async findOpen(
    userId: string,
    sessionId: string,
  ): Promise<Pick<UserSession, 'id' | 'created_at'> | null> {
    if (!/^\d+$/.test(String(userId)) || !isSessionId(sessionId)) {
      return null;
    }
    const row = await this.sessions.findOne({
      select: ['id', 'created_at'],
      where: {
        id: sessionId.toLowerCase(),
        user_id: String(userId),
        revoked_at: IsNull(),
      },
    });
    return row ? { id: row.id, created_at: row.created_at } : null;
  }

  /**
   * «Sessiyalar» ro'yxati — faqat SHU foydalanuvchining OCHIQ sessiyalari
   * (`revoked_at IS NULL`, `epoch` joriy), `expires_at` i retention oynasida
   * (SESSION_RETENTION_DAYS dan eski emas). Har qatorda `status`:
   * `active` — muddati o'tmagan va parol izi joriy; aks holda `expired`
   * («Qayta kirish kerak» — shu qurilmadan login AYNI qatorni tiklaydi).
   *
   * Tartib: joriy sessiya → faollar → muddati o'tganlar (ikkalasi oxirgi
   * faollik bo'yicha kamayish). `active_count` — FAQAT faollar soni.
   * Tizim bo'yicha umumiy son/ro'yxat YO'Q. So'rovlar
   * `IDX_USER_SESSIONS_USER_ACTIVE` (user_id, last_seen_at) WHERE
   * revoked_at IS NULL bo'yicha, har biri ≤ SESSION_LIST_LIMIT qator.
   */
  async listOwn(
    user: User,
    currentSessionId: string | null | undefined,
    now = new Date(),
  ): Promise<OwnSessionsList> {
    const fp = passwordFingerprint(user.password);
    const open = {
      user_id: String(user.id),
      revoked_at: IsNull(),
      epoch: Number(user.session_epoch) || 0,
    };
    const retentionCutoff = new Date(
      now.getTime() - SESSION_RETENTION_DAYS * DAY_MS,
    );
    const order: FindOptionsOrder<UserSession> = {
      last_seen_at: 'DESC',
      created_at: 'DESC',
    };

    const [active, activeCount] = await this.sessions.findAndCount({
      where: { ...open, password_fp: fp, expires_at: MoreThan(now) },
      order,
      take: SESSION_LIST_LIMIT,
    });
    const expired = await this.sessions.find({
      where: [
        { ...open, expires_at: Between(retentionCutoff, now) },
        { ...open, password_fp: Not(fp), expires_at: MoreThan(now) },
      ],
      order,
      take: SESSION_LIST_LIMIT,
    });

    const currentId = isSessionId(currentSessionId)
      ? currentSessionId.toLowerCase()
      : null;
    let current: UserSession | null = null;
    if (currentId) {
      current =
        [...active, ...expired].find((row) => row.id === currentId) ??
        (await this.sessions.findOne({
          where: {
            ...open,
            id: currentId,
            expires_at: MoreThan(retentionCutoff),
          },
        }));
    }

    const others = (rows: UserSession[]) =>
      rows.filter((row) => row.id !== current?.id);
    const ordered = [
      ...(current ? [current] : []),
      ...others(active),
      ...others(expired),
    ].slice(0, SESSION_LIST_LIMIT);

    return {
      active_count: activeCount,
      sessions: ordered.map((row) => ({
        id: row.id,
        status:
          row.password_fp === fp &&
          new Date(row.expires_at).getTime() > now.getTime()
            ? 'active'
            : 'expired',
        device_name: row.device_name ?? null,
        device_id: row.device_id ?? null,
        user_agent: row.user_agent ?? null,
        ip: row.ip ?? null,
        first_logged_in_at: new Date(row.created_at).toISOString(),
        logged_in_at: new Date(
          row.last_login_at ?? row.created_at,
        ).toISOString(),
        last_seen_at: new Date(row.last_seen_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        current: row.id === current?.id,
      })),
    };
  }

  /**
   * Soatlik tozalash (OTP tozalash bilan bir xil shakl):
   *  1. epoch'i eskirgan (xavfsizlik hodisasidan keyingi) ochiq qatorlarga
   *     `revoked_at` + `security_reset` yoziladi — epoch tekshiruvi baribir
   *     darhol amal qilgan, bu faqat bazadagi holatni haqiqatga moslaydi.
   *     (2026-10-24) Yopilgan id lar gateway'ga e'lon qilinadi
   *     (`auth.sessions.kick`) — ochiq socketlar `auth:session_revoked`
   *     olib uziladi.
   *     Muddati o'tganlari ham (2026-10-23 dan): ochiq qator endi qurilma
   *     belgisi — u qurilma kalitini (`UQ_USER_SESSIONS_USER_DEVICE_OPEN`)
   *     band qilib turmasin;
   *  2. `expires_at` dan SESSION_RETENTION_DAYS (90) o'tgan qatorlar
   *     (yopilganlari ham) partiyalab o'chiriladi.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(now = new Date()): Promise<{ reset: number; deleted: number }> {
    const resetResult: unknown = await this.sessions.query(
      `UPDATE "identity_schema"."user_sessions" s
          SET "revoked_at" = $1, "revoke_reason" = 'security_reset'
         FROM "identity_schema"."admins" a
        WHERE a."id" = s."user_id"
          AND s."revoked_at" IS NULL
          AND s."epoch" <> a."session_epoch"
      RETURNING s."id"`,
      [now],
    );
    // Postgres drayveri UPDATE uchun `[rows, rowCount]` qaytaradi.
    const reset =
      Array.isArray(resetResult) && typeof resetResult[1] === 'number'
        ? resetResult[1]
        : 0;
    // (2026-10-24) Epoch hodisasidan keyin hali ochiq socketlar — darhol uziladi.
    this.announceSecurityReset(returnedIds(resetResult));

    const cutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    for (let round = 0; round < 20; round += 1) {
      const stale = await this.sessions.find({
        select: ['id'],
        where: { expires_at: LessThan(cutoff) },
        take: CLEANUP_BATCH,
      });
      if (!stale.length) break;
      const result = await this.sessions.delete(stale.map((row) => row.id));
      deleted += result.affected ?? 0;
      if (stale.length < CLEANUP_BATCH) break;
    }
    if (reset || deleted) {
      this.logger.log(
        `Sessiyalar: ${reset} ta yopildi (security_reset), ${deleted} ta eskirgan qator tozalandi`,
      );
    }
    return { reset, deleted };
  }
}
