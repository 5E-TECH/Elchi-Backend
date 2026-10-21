import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { requestContext } from '@app/common';
import { User } from '../entities/user.entity';
import {
  UserSession,
  UserSessionMethod,
  UserSessionRevokeReason,
} from '../entities/user-session.entity';
import {
  hashRefreshToken,
  isSessionId,
  passwordFingerprint,
} from './session-security';

export {
  hashRefreshToken,
  invalidateAllSessions,
  isSessionId,
  passwordFingerprint,
} from './session-security';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 1000;

/**
 * Muddati o'tgan / yopilgan sessiya qatori shuncha kun saqlanadi (tergov
 * uchun), keyin soatlik tozalash o'chiradi. Har qator `expires_at` dan
 * keyin (refresh ≤ REFRESH_TOKEN_TIME) baribir yaroqsiz.
 */
export const SESSION_RETENTION_DAYS = 30;

/** Ro'yxatda ko'pi bilan shuncha faol sessiya qaytadi (`active_count` — hammasi). */
export const SESSION_LIST_LIMIT = 50;

/** Sessiya nega yaroqsiz (`null` — yaroqli). */
export type SessionRejectReason =
  | 'foreign'
  | 'revoked'
  | 'reset'
  | 'password_changed'
  | 'expired';

/** `GET /auth/sessions` qatori — faqat egasiga. Token/hash/epoch CHIQMAYDI. */
export interface OwnSessionView {
  id: string;
  device_name: string | null;
  device_id: string | null;
  user_agent: string | null;
  ip: string | null;
  logged_in_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

export interface OwnSessionsList {
  active_count: number;
  sessions: OwnSessionView[];
}

/**
 * (Elchi Pochta #3 — "Sessionlar bo'limi") Har login uchun alohida sessiya:
 * ochish, refresh'da tekshirish, logout'da faqat joriy sessiyani yopish,
 * egasiga o'z faol sessiyalari ro'yxati va soatlik tozalash.
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
  ) {}

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
    return this.sessions.create({
      id: randomUUID(),
      user_id: String(input.user.id),
      refresh_token_hash: hashRefreshToken(input.refreshToken),
      epoch: Number(input.user.session_epoch) || 0,
      password_fp: passwordFingerprint(input.user.password),
      method: input.method,
      created_at: input.createdAt ?? input.now,
      last_seen_at: input.now,
      expires_at: input.expiresAt,
      revoked_at: null,
      revoke_reason: null,
      device_id: audit.device_id ?? null,
      device_name: audit.device_name ?? null,
      user_agent: audit.user_agent ?? null,
      ip: audit.ip ?? null,
    });
  }

  /**
   * Yangi login → YANGI sessiya. Foydalanuvchining boshqa sessiyalariga
   * TEGILMAYDI (bir nechta qurilmadan bir vaqtda kirish mumkin).
   */
  async open(input: {
    user: User;
    refreshToken: string;
    expiresAt: Date;
    method: Exclude<UserSessionMethod, 'legacy'>;
    now?: Date;
  }): Promise<UserSession> {
    const row = this.build({ ...input, now: input.now ?? new Date() });
    await this.sessions.insert(row);
    return row;
  }

  /**
   * Deploy'dan OLDIN kirgan foydalanuvchi: refresh tokeni `admins.refresh_token`
   * hashiga mos, lekin sessiya qatori yo'q. Birinchi refresh'da qator
   * yaratiladi (login vaqti — eski JWT'ning `iat` i, muddati — `exp`) va
   * keyin u oddiy sessiya. Hech kim chiqarib yuborilmaydi.
   *
   * Ikki tab bir vaqtda refresh qilsa ikkinchi INSERT UNIQUE'ga uriladi —
   * u holda birinchisi yaratgan qator qaytadi.
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
      if ((error as { code?: string })?.code !== '23505') throw error;
      return this.findByHash(row.refresh_token_hash);
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
      revoked += result.affected ?? 0;
    }
    return revoked;
  }

  /**
   * Faqat SHU foydalanuvchining faol sessiyalari (yopilmagan, muddati
   * o'tmagan, epoch va parol barmoq izi joriy) — oxirgi faollik bo'yicha
   * kamayish tartibida. Tizim bo'yicha umumiy son/ro'yxat YO'Q.
   */
  async listOwn(
    user: User,
    currentSessionId: string | null | undefined,
    now = new Date(),
  ): Promise<OwnSessionsList> {
    const [rows, activeCount] = await this.sessions.findAndCount({
      where: {
        user_id: String(user.id),
        revoked_at: IsNull(),
        epoch: Number(user.session_epoch) || 0,
        password_fp: passwordFingerprint(user.password),
        expires_at: MoreThan(now),
      },
      order: { last_seen_at: 'DESC', created_at: 'DESC' },
      take: SESSION_LIST_LIMIT,
    });
    const current = isSessionId(currentSessionId) ? currentSessionId : null;
    return {
      active_count: activeCount,
      sessions: rows.map((row) => ({
        id: row.id,
        device_name: row.device_name ?? null,
        device_id: row.device_id ?? null,
        user_agent: row.user_agent ?? null,
        ip: row.ip ?? null,
        logged_in_at: new Date(row.created_at).toISOString(),
        last_seen_at: new Date(row.last_seen_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        current: current !== null && row.id === current,
      })),
    };
  }

  /**
   * Soatlik tozalash (OTP tozalash bilan bir xil shakl):
   *  1. epoch'i eskirgan (xavfsizlik hodisasidan keyingi) ochiq qatorlarga
   *     `revoked_at` + `security_reset` yoziladi — epoch tekshiruvi baribir
   *     darhol amal qilgan, bu faqat bazadagi holatni haqiqatga moslaydi;
   *  2. `expires_at` dan SESSION_RETENTION_DAYS o'tgan qatorlar (yopilganlari
   *     ham — ularning `expires_at` i ham login + REFRESH_TOKEN_TIME)
   *     partiyalab o'chiriladi.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(now = new Date()): Promise<{ reset: number; deleted: number }> {
    const resetResult: unknown = await this.sessions.query(
      `UPDATE "identity_schema"."user_sessions" s
          SET "revoked_at" = $1, "revoke_reason" = 'security_reset'
         FROM "identity_schema"."admins" a
        WHERE a."id" = s."user_id"
          AND s."revoked_at" IS NULL
          AND s."expires_at" > $1
          AND s."epoch" <> a."session_epoch"`,
      [now],
    );
    // Postgres drayveri UPDATE uchun `[rows, rowCount]` qaytaradi.
    const reset =
      Array.isArray(resetResult) && typeof resetResult[1] === 'number'
        ? resetResult[1]
        : 0;

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
