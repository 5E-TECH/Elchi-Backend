import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserActivity } from '../entities/user-activity.entity';

/** Bitta foydalanuvchining faolligi (gateway `GET /users` boyitishi uchun). */
export interface UserActivityView {
  user_id: string;
  last_login_at: string | null;
  last_seen_at: string | null;
}

/** Bir so'rovda ko'pi bilan shuncha id (ro'yxat sahifasi ≤ 100). */
export const USER_ACTIVITY_MAX_IDS = 200;

/**
 * Gateway yuborgan `at` qancha eski bo'lishi mumkin: socket uzilishi
 * 45 s kutishdan keyin yoziladi, RMQ navbati kechiksa ham — 1 kundan eski
 * vaqt (soat xatosi yoki eski xabar) yozilmaydi.
 */
const SEEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const USER_ID_RE = /^\d{1,19}$/;

const UPSERT_LOGIN_SQL = `
  INSERT INTO "identity_schema"."user_activity" ("user_id", "last_login_at", "last_seen_at")
  VALUES ($1, $2, $2)
  ON CONFLICT ("user_id") DO UPDATE
     SET "last_login_at" = GREATEST("user_activity"."last_login_at", EXCLUDED."last_login_at"),
         "last_seen_at" = GREATEST("user_activity"."last_seen_at", EXCLUDED."last_seen_at")
`;

const UPSERT_SEEN_SQL = `
  INSERT INTO "identity_schema"."user_activity" ("user_id", "last_seen_at")
  VALUES ($1, $2)
  ON CONFLICT ("user_id") DO UPDATE
     SET "last_seen_at" = GREATEST("user_activity"."last_seen_at", EXCLUDED."last_seen_at")
`;

/** Refresh: sessiya id bo'yicha (egasi `user_sessions` dan). */
const UPSERT_SEEN_BY_SESSION_SQL = `
  INSERT INTO "identity_schema"."user_activity" ("user_id", "last_seen_at")
  SELECT s."user_id", $2 FROM "identity_schema"."user_sessions" s WHERE s."id" = $1
  ON CONFLICT ("user_id") DO UPDATE
     SET "last_seen_at" = GREATEST("user_activity"."last_seen_at", EXCLUDED."last_seen_at")
`;

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * (pe71yf8L) «Oxirgi kirish» va «Oxirgi faollik» — `identity_schema.user_activity`.
 *
 * Yozish BEST-EFFORT: xato faqat logga yoziladi, login / refresh / socket
 * oqimini to'xtatmaydi. Hamma yozuv `GREATEST` bilan — kechikib kelgan eski
 * vaqt yangisini bosib ketmaydi.
 */
@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);

  constructor(
    @InjectRepository(UserActivity)
    private readonly rows: Repository<UserActivity>,
  ) {}

  /** Login (yangi yoki qayta ishlatilgan sessiya) — oxirgi kirish + faollik. */
  async recordLogin(userId: string | number, at = new Date()): Promise<void> {
    const id = String(userId);
    if (!USER_ID_RE.test(id)) return;
    await this.run('login', () => this.rows.query(UPSERT_LOGIN_SQL, [id, at]));
  }

  /** Muvaffaqiyatli refresh — sessiya egasining oxirgi faolligi. */
  async recordSeenBySession(sessionId: string, at = new Date()): Promise<void> {
    if (!sessionId) return;
    await this.run('refresh', () =>
      this.rows.query(UPSERT_SEEN_BY_SESSION_SQL, [sessionId, at]),
    );
  }

  /**
   * Gateway `/realtime` socketi: ulanish (offline → online) yoki oxirgi
   * socket uzilishi. `at` — gateway vaqti; kelajakdagisi `now` ga
   * qisqartiriladi, 1 kundan eskisi tashlanadi. Yozildimi — `true`.
   */
  async recordSeen(
    userId: unknown,
    at: unknown,
    now = new Date(),
  ): Promise<boolean> {
    const id =
      typeof userId === 'string' || typeof userId === 'number'
        ? String(userId)
        : '';
    if (!USER_ID_RE.test(id)) return false;
    const parsed =
      typeof at === 'string' || typeof at === 'number' || at instanceof Date
        ? new Date(at)
        : now;
    if (Number.isNaN(parsed.getTime())) return false;
    if (now.getTime() - parsed.getTime() > SEEN_MAX_AGE_MS) return false;
    const when = parsed.getTime() > now.getTime() ? now : parsed;
    return this.run('seen', () => this.rows.query(UPSERT_SEEN_SQL, [id, when]));
  }

  /** Berilgan id'lar faolligi; qatori yo'q id — javobda yo'q. */
  async findByUserIds(userIds: unknown): Promise<UserActivityView[]> {
    const ids = [
      ...new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number' ? String(id) : '',
          )
          .filter((id) => USER_ID_RE.test(id)),
      ),
    ].slice(0, USER_ACTIVITY_MAX_IDS);
    if (!ids.length) return [];
    const found = await this.rows
      .createQueryBuilder('a')
      .where('a.user_id IN (:...ids)', { ids })
      .getMany();
    return found.map((row) => ({
      user_id: String(row.user_id),
      last_login_at: toIso(row.last_login_at),
      last_seen_at: toIso(row.last_seen_at),
    }));
  }

  private async run(
    kind: string,
    write: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      this.logger.warn(
        `user_activity ${kind} yozilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
