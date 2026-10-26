import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, In, PrimaryColumn, Repository } from 'typeorm';

/**
 * (NDmZMzCP, 2026-10-26) Telefon bo'yicha xato login hisoblagichi + backoff.
 * Jadval — 1716000000164 migratsiyasi. Redis yo'q, shuning uchun Postgres:
 * bir nechta identity instansi bir xil hisobni ko'radi.
 */
@Entity({ schema: 'identity_schema', name: 'auth_login_throttle' })
export class AuthLoginThrottle {
  @PrimaryColumn({ type: 'varchar', length: 160 })
  key!: string;

  @Column({ type: 'integer', default: 0 })
  fail_count!: number;

  @Column({ type: 'timestamptz' })
  first_failed_at!: Date;

  @Column({ type: 'timestamptz' })
  last_failed_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  locked_until!: Date | null;
}

/** Hisob turi: `phone_ip` — shu telefon + shu IP; `phone` — barcha IP'lar. */
export type LoginThrottleScope = 'phone_ip' | 'phone';

export interface LoginThrottleRule {
  /** Shuncha ketma-ket xatodan keyin qulf boshlanadi. */
  threshold: number;
}

/**
 * QOIDA (time-boxed — doimiy qulf YO'Q):
 *  - `phone_ip`: 5 ta xato → 1 daqiqa, keyin har xato qulfni ikki barobar
 *    (2, 4, 8 …) — ko'pi bilan 15 daqiqa;
 *  - `phone` (barcha IP'lar — taqsimlangan hujum): 20 ta xato → xuddi shu
 *    backoff. Bu qulfni foydalanuvchining TANISH qurilmasi / IP'si
 *    (`user_sessions` da bor) chetlab o'tadi — hujumchi superadmin'ni
 *    boshqa IP'lardan urinib chiqarib qo'ya olmaydi;
 *  - qulf davomidagi urinish parolni TEKSHIRMAYDI va hisobni OSHIRMAYDI
 *    (hujumchi qulfni cheksiz uzaytira olmaydi);
 *  - oxirgi xatodan 15 daqiqa o'tsa (qulf yo'q bo'lsa) hisob noldan;
 *  - muvaffaqiyatli kirish — ikkala hisob o'chadi.
 */
export const LOGIN_THROTTLE_RULES: Readonly<
  Record<LoginThrottleScope, LoginThrottleRule>
> = {
  phone_ip: { threshold: 5 },
  phone: { threshold: 20 },
};
export const LOGIN_LOCK_BASE_MS = 60_000;
export const LOGIN_LOCK_MAX_MS = 15 * 60_000;
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;

/** `fail_count` uchun qulf muddati (ms); chegaraga yetmagan — 0. */
export function loginLockDurationMs(
  failCount: number,
  threshold: number,
): number {
  if (failCount < threshold) return 0;
  const steps = Math.min(failCount - threshold, 10);
  return Math.min(LOGIN_LOCK_BASE_MS * 2 ** steps, LOGIN_LOCK_MAX_MS);
}

export interface LoginThrottleKeys {
  phone: string;
  phone_ip: string | null;
}

/** Kalitlar: telefon hash'i (raqam o'zi yozilmaydi) va IP. */
export function loginThrottleKeys(
  phoneKey: string,
  ip: string | null | undefined,
): LoginThrottleKeys {
  const cleanIp = String(ip ?? '')
    .trim()
    .slice(0, 64);
  return {
    phone: `p:${phoneKey}`,
    phone_ip: cleanIp ? `pi:${phoneKey}:${cleanIp}` : null,
  };
}

export interface LoginLockState {
  locked_until: Date;
  scope: LoginThrottleScope;
}

export interface LoginFailureResult {
  /** Shu xato bilan YANGI boshlangan qulflar (ogohlantirish uchun). */
  locked: Array<LoginLockState & { fail_count: number }>;
}

@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  constructor(
    @InjectRepository(AuthLoginThrottle)
    private readonly rows: Repository<AuthLoginThrottle>,
  ) {}

  /**
   * Hozir amaldagi qulf (eng uzog'i) yoki `null`. `ignorePhoneScope` —
   * tanish qurilma/IP: umumiy telefon qulfi unga ta'sir qilmaydi
   * (`phone_ip` qulfi baribir amal qiladi). Bazaga yetib bo'lmasa — `null`
   * (login ishlashda davom etadi; gateway IP throttle baribir bor).
   */
  async activeLock(
    keys: LoginThrottleKeys,
    now: Date,
    options: { ignorePhoneScope?: boolean } = {},
  ): Promise<LoginLockState | null> {
    const wanted: Array<[LoginThrottleScope, string]> = [];
    if (keys.phone_ip) wanted.push(['phone_ip', keys.phone_ip]);
    if (!options.ignorePhoneScope) wanted.push(['phone', keys.phone]);
    if (!wanted.length) return null;
    let found: AuthLoginThrottle[];
    try {
      found = await this.rows.find({
        where: { key: In(wanted.map(([, key]) => key)) },
      });
    } catch (error) {
      this.logger.warn(
        `Login qulfi o'qilmadi: ${(error as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
    let best: LoginLockState | null = null;
    for (const [scope, key] of wanted) {
      const row = found.find((item) => item.key === key);
      const until = row?.locked_until ? new Date(row.locked_until) : null;
      if (!until || until.getTime() <= now.getTime()) continue;
      if (!best || until.getTime() > best.locked_until.getTime()) {
        best = { locked_until: until, scope };
      }
    }
    return best;
  }

  /**
   * Xato urinish: har kalit uchun atomar UPSERT (oyna o'tgan bo'lsa hisob
   * 1 dan), chegaradan oshsa `locked_until` = hozir + backoff. Qaytadi —
   * shu chaqiruvda yangi boshlangan qulflar. Xato bo'lsa — ogohlantirish,
   * login javobi o'zgarmaydi (401).
   */
  async recordFailure(
    keys: LoginThrottleKeys,
    now: Date,
  ): Promise<LoginFailureResult> {
    const locked: LoginFailureResult['locked'] = [];
    const targets: Array<[LoginThrottleScope, string]> = [
      ['phone', keys.phone],
    ];
    if (keys.phone_ip) targets.push(['phone_ip', keys.phone_ip]);
    const windowStart = new Date(now.getTime() - LOGIN_FAIL_WINDOW_MS);
    for (const [scope, key] of targets) {
      try {
        const result: unknown = await this.rows.query(
          `INSERT INTO "identity_schema"."auth_login_throttle" AS t
             ("key", "fail_count", "first_failed_at", "last_failed_at", "locked_until")
           VALUES ($1, 1, $2, $2, NULL)
           ON CONFLICT ("key") DO UPDATE SET
             "fail_count" = CASE
               WHEN t."last_failed_at" < $3
                AND (t."locked_until" IS NULL OR t."locked_until" <= $2)
               THEN 1 ELSE t."fail_count" + 1 END,
             "first_failed_at" = CASE
               WHEN t."last_failed_at" < $3
                AND (t."locked_until" IS NULL OR t."locked_until" <= $2)
               THEN $2 ELSE t."first_failed_at" END,
             "last_failed_at" = $2
           RETURNING "fail_count"`,
          [key, now, windowStart],
        );
        const failCount = Number(
          (Array.isArray(result)
            ? (result[0] as { fail_count?: unknown })
            : null
          )?.fail_count ?? 0,
        );
        const lockMs = loginLockDurationMs(
          failCount,
          LOGIN_THROTTLE_RULES[scope].threshold,
        );
        if (lockMs > 0) {
          const until = new Date(now.getTime() + lockMs);
          await this.rows.update({ key }, { locked_until: until });
          locked.push({ scope, locked_until: until, fail_count: failCount });
        }
      } catch (error) {
        this.logger.warn(
          `Login xato hisobi yozilmadi (${scope}): ${(error as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    return { locked };
  }

  /** Muvaffaqiyatli kirish — shu telefon (va IP) hisoblari o'chadi. */
  async reset(keys: LoginThrottleKeys): Promise<void> {
    const list = [keys.phone, keys.phone_ip].filter(
      (key): key is string => typeof key === 'string' && key.length > 0,
    );
    try {
      await this.rows.delete({ key: In(list) });
    } catch (error) {
      this.logger.warn(
        `Login hisobi tozalanmadi: ${(error as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /** Eski qatorlar (qulfi tugagan, oxirgi xato 1 kundan oldin) — kuniga. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purge(now = new Date()): Promise<number> {
    const result: unknown = await this.rows.query(
      `DELETE FROM "identity_schema"."auth_login_throttle"
        WHERE "last_failed_at" < $1
          AND ("locked_until" IS NULL OR "locked_until" < $1)`,
      [new Date(now.getTime() - 24 * 60 * 60 * 1000)],
    );
    return Array.isArray(result) && typeof result[1] === 'number'
      ? result[1]
      : 0;
  }
}
