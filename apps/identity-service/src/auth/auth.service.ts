import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { StringValue } from 'ms';
import { User } from '../entities/user.entity';
import {
  AuthSessionService,
  type OwnSessionsList,
  type SessionRejectReason,
  hashRefreshToken,
  isSessionId,
} from './auth-session.service';
import {
  formatTashkentMinuteCeil,
  resolveSessionRevokeLockMs,
  sessionRevokeLock,
} from './session-security';
import type { UserSession } from '../entities/user-session.entity';
import { BcryptEncryption } from '../../../../libs/common/helpers/bcrypt';
import { LoginDto } from './dto/login.dto';
import {
  type LoginThrottleKeys,
  LoginThrottleService,
  loginThrottleKeys,
} from './login-throttle.service';
import { RefreshDto } from './dto/refresh.dto';
import {
  ActivityAction,
  ActivityDescribeUz,
  ActivityLogMaintenanceService,
  ActivityLogService,
  LOGIN_LOCKED,
  Roles,
  SESSION_TOO_NEW,
  Status,
  captureException,
  computeHmacSignature,
  isPasswordPolicyCompliant,
  normalizeUzPhone,
  requestContext,
  resolveLoginDedupWindowMs,
  rmqSend,
  verifyTelegramInitData,
} from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';

/** `REFRESH_TOKEN_TIME` sukuti (prod: 1d) va JWT `exp` o'qilmasa zaxira muddat. */
const DEFAULT_REFRESH_TOKEN_TIME = '1d';
const DEFAULT_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * (Elchi Pochta #3) Egasi sessiyalarini yopganda javob: nechta yopildi va
 * qaysilari — gateway shu id larni o'z keshida darhol «yopilgan» deb
 * belgilaydi (access token muddati tugashini kutmaydi).
 */
export interface RevokedSessionsResponse {
  statusCode: number;
  message: string;
  data: { revoked: number; session_ids: string[] };
}

/**
 * (Elchi Pochta #3, 2026-10-23) `GET /auth/sessions` — ro'yxat + joriy
 * sessiya boshqalarni yopa oladimi (48 soatlik qulf).
 */
export interface OwnSessionsWithLock extends OwnSessionsList {
  /** Joriy sessiya hozir boshqa sessiyalarni yopa oladimi. */
  can_revoke_others: boolean;
  /**
   * Qachondan yopa oladi (ISO). Hozir mumkin bo'lsa yoki joriy sessiya
   * aniqlanmasa (`sid` siz token) — `null`.
   */
  revoke_available_at: string | null;
}

/** Joriy sessiya aniqlanmadi — revoke-others va (qulf yoqilganda) DELETE. */
const CURRENT_SESSION_UNKNOWN = 'Joriy sessiya aniqlanmadi — qayta kiring';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly bcryptEncryption: BcryptEncryption,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
    /** (Elchi Pochta #3) Har login — alohida sessiya (`user_sessions`). */
    private readonly sessions: AuthSessionService,
    /**
     * i6Nyedea — takroriy login birlashtiriladi (yangi qator o'rniga
     * `metadata.count` oshadi). Ixtiyoriy: spec'lar servisni usiz quradi —
     * u holda avvalgidek har login yangi qator.
     */
    @Optional()
    private readonly activityLogMaintenance?: ActivityLogMaintenanceService,
    /**
     * (NDmZMzCP) Telefon bo'yicha xato login hisoblagichi. Ixtiyoriy:
     * spec'lar servisni usiz quradi — u holda qulf yo'q (avvalgidek).
     */
    @Optional()
    private readonly loginThrottle?: LoginThrottleService,
  ) {}

  /**
   * Resolve the user's current branch assignment from branch-service.
   * Returns null when the user has no branch (e.g. SUPERADMIN, MARKET, CUSTOMER).
   * Failure is non-fatal: tokens still issue with branch_id=null and downstream
   * services fall back to BranchUser lookup.
   */
  private async resolveBranchId(userId: string): Promise<string | null> {
    try {
      const response = await rmqSend<{ data?: { branch_id?: string | null } }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: String(userId),
          requester: { id: String(userId), roles: ['SUPERADMIN'] },
        },
        { attachRequestId: false, retries: 1, timeoutMs: 3000 },
      );
      const branchId = response?.data?.branch_id;
      return branchId ? String(branchId) : null;
    } catch (error) {
      this.logger.warn(
        `branch.user.find_by_user failed for user ${userId}: ${(error as Error)?.message ?? 'unknown'} — issuing tokens without branch_id`,
      );
      return null;
    }
  }

  /**
   * Telefonni jurnal uchun: to'liq raqam YOZILMAYDI (rkz0yBxr #8, f2Ud5tju #5)
   * — faqat maska (***7434) va guruhlash/tergov uchun barqaror HMAC hash.
   *
   * NORMALLASHTIRISH: hash'dan OLDIN raqam `+998XXXXXXXXX` ga keltiriladi
   * (`normalizeUzPhone` — AI/OTP oqimlari bilan AYNI qoida), shuning uchun
   * "900000000", "90 000 00 00", "998900000000", "+998 90 000 00 00" BITTA
   * hash beradi. Hash kirishi avvalgidek `phone:+998XXXXXXXXX` — mavjud
   * qatorlardagi hash'lar o'zgarmaydi. UZ raqamiga keltirib bo'lmaydigan
   * kirish (`raw:` prefiksli raqamlar) haqiqiy raqam hash'i bilan to'qnashmaydi.
   *
   * KALIT: `OTP_HASH_SECRET`, bo'lmasa `ACCESS_TOKEN_KEY` (identity'da majburiy).
   * Qattiq kodlangan zaxira kalit YO'Q: kalit topilmasa hash `null` — taxmin
   * qilinadigan kalit bilan hash raqamni lug'at hujumiga ochib qo'yardi.
   * HMAC — umumiy `computeHmacSignature` (libs/common/src/webhook/hmac.ts).
   */
  phoneForAudit(phone: string): {
    phone_masked: string;
    phone_hash: string | null;
  } {
    const normalized = normalizeUzPhone(phone);
    const digits = normalized
      ? normalized.slice(4)
      : String(phone ?? '').replace(/\D/g, '');
    const key =
      this.configService.get<string>('OTP_HASH_SECRET') ||
      this.configService.get<string>('ACCESS_TOKEN_KEY') ||
      '';
    return {
      phone_masked: digits.length >= 4 ? `***${digits.slice(-4)}` : '***',
      phone_hash: key
        ? computeHmacSignature(
            normalized ? `phone:${normalized}` : `phone:raw:${digits}`,
            key,
          ).slice(0, 32)
        : null,
    };
  }

  /**
   * Record a failed login attempt for the security audit trail.
   *
   * f2Ud5tju #5: `entity_id` da raqam HECH QACHON yo'q — ma'lum
   * foydalanuvchida uning ID si, noma'lumda HMAC hash (bir raqamdan
   * urinishlarni guruhlash uchun), kalit bo'lmasa `'unknown'`. Shu sabab
   * `search=<raqam>` jurnaldan hech narsa topmaydi. IP/qurilma metadata'ga
   * `ActivityLogService.log()` tomonidan avtomatik qo'shiladi.
   */
  private async logAuthFailure(
    phone: string,
    reason: string,
    userId?: string,
  ): Promise<void> {
    const audit = this.phoneForAudit(phone);
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: userId ?? audit.phone_hash ?? 'unknown',
      action: ActivityAction.AUTH_FAILURE,
      user_id: userId ?? null,
      metadata: { ...audit, reason },
      description: ActivityDescribeUz.authFailure(reason),
    });
  }

  /**
   * Parol bilan kirish. (NDmZMzCP, 2026-10-26):
   *  - TIMING: noma'lum telefon va nofaol foydalanuvchida ham bcrypt
   *    (soxta xesh bilan) — javob vaqti telefon mavjudligini oshkor qilmaydi;
   *  - QULF: telefon (+IP) bo'yicha ketma-ket xatolar → vaqtinchalik qulf
   *    (`LoginThrottleService`, ko'pi bilan 15 daqiqa) — 429 `LOGIN_LOCKED`,
   *    parol TEKSHIRILMAYDI; qulf boshlanganda ogohlantirish (log + Sentry +
   *    faoliyat jurnali);
   *  - REHASH: xesh narxi 12 dan past bo'lsa muvaffaqiyatli kirishda qayta
   *    xeshlanadi (sessiyalar parol izi bilan birga — hech kim chiqmaydi);
   *  - ZAIF PAROL: mavjud parol yangi siyosatga mos kelmasa login BARIBIR
   *    muvaffaqiyatli, faqat `must_change_password = true` (javobda va
   *    tokenda `pwd_change`) — foydalanuvchi parolni almashtirishga
   *    yo'naltiriladi, chiqarib yuborilmaydi.
   */
  async login(dto: LoginDto) {
    const now = new Date();
    const audit = requestContext.getAuditContext();
    const throttleKeys = this.loginThrottleKeys(dto.phone_number, audit.ip);
    const user = await this.users.findOne({
      where: { phone_number: dto.phone_number, isDeleted: false },
    });

    if (this.loginThrottle && throttleKeys) {
      let lock = await this.loginThrottle.activeLock(throttleKeys, now);
      // Telefonning UMUMIY qulfi (taqsimlangan hujum) — egasining tanish
      // qurilmasi / IP'sini to'xtatmaydi (faqat shu IP qulfi qoladi).
      if (
        lock?.scope === 'phone' &&
        user &&
        (await this.sessions.isKnownDevice(user.id, {
          deviceId: audit.device_id ?? null,
          ip: audit.ip ?? null,
        }))
      ) {
        lock = await this.loginThrottle.activeLock(throttleKeys, now, {
          ignorePhoneScope: true,
        });
      }
      if (lock) {
        await this.logAuthFailure(dto.phone_number, 'locked', user?.id);
        throw this.loginLockedError(lock.locked_until, now);
      }
    }

    if (!user || user.status !== Status.ACTIVE) {
      // Timing: topilmagan / nofaol foydalanuvchida ham AYNI narxdagi bcrypt.
      await this.burnPasswordCheck(dto.password);
      await this.onLoginFailure(
        dto.phone_number,
        user ? 'inactive' : 'user_not_found',
        throttleKeys,
        now,
        user?.id,
      );
      throw new RpcException(errorRes('Invalid credentials', 401));
    }

    const isMatch = await this.bcryptEncryption.compare(
      dto.password,
      user.password,
    );
    if (!isMatch) {
      await this.onLoginFailure(
        dto.phone_number,
        'bad_password',
        throttleKeys,
        now,
        user.id,
      );
      throw new RpcException(errorRes('Invalid credentials', 401));
    }

    if (this.loginThrottle && throttleKeys) {
      await this.loginThrottle.reset(throttleKeys);
    }
    await this.rehashIfNeeded(user, dto.password);
    await this.flagWeakPassword(user, dto.password);
    return this.sessionForUser(user);
  }

  /** Timing: soxta xesh bilan bcrypt (natija ahamiyatsiz, xato yutiladi). */
  private async burnPasswordCheck(password: string): Promise<void> {
    try {
      await this.bcryptEncryption.compareDummy(password);
    } catch {
      // faqat vaqt uchun
    }
  }

  /** Telefon hash'i (bo'lmasa normallashgan raqam) + IP → qulf kalitlari. */
  private loginThrottleKeys(
    phone: string,
    ip: string | undefined,
  ): LoginThrottleKeys | null {
    const audit = this.phoneForAudit(phone);
    const normalized = normalizeUzPhone(phone);
    const phoneKey =
      audit.phone_hash ??
      (normalized
        ? normalized.slice(1)
        : String(phone ?? '')
            .replace(/\D/g, '')
            .slice(0, 20));
    return phoneKey ? loginThrottleKeys(phoneKey, ip ?? null) : null;
  }

  /** 429 — qachon qayta urinish mumkin (soniya, daqiqaga yaxlitlangan matn). */
  private loginLockedError(lockedUntil: Date, now: Date): RpcException {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
    );
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return new RpcException({
      statusCode: 429,
      message: `Juda ko'p noto'g'ri urinish — ${minutes} daqiqadan keyin qayta urinib ko'ring`,
      data: null,
      code: LOGIN_LOCKED,
      retry_after_seconds: retryAfterSeconds,
    });
  }

  /**
   * Xato urinish: jurnal (avvalgidek) + hisoblagich. Qulf YANGI boshlansa —
   * ogohlantirish: `warn` log, Sentry xabari va faoliyat jurnalida
   * `login_locked` (telefon faqat maska/hash).
   */
  private async onLoginFailure(
    phone: string,
    reason: string,
    keys: LoginThrottleKeys | null,
    now: Date,
    userId?: string,
  ): Promise<void> {
    await this.logAuthFailure(phone, reason, userId);
    if (!this.loginThrottle || !keys) return;
    const { locked } = await this.loginThrottle.recordFailure(keys, now);
    for (const lock of locked) {
      const audit = this.phoneForAudit(phone);
      const minutes = Math.round(
        (lock.locked_until.getTime() - now.getTime()) / 60_000,
      );
      const text = `Login qulfi: ${audit.phone_masked} — ${lock.fail_count} ta xato (${lock.scope}), ${minutes} daqiqa`;
      this.logger.warn(text);
      captureException(new Error(text), {
        kind: 'login_lockout',
        scope: lock.scope,
        fail_count: lock.fail_count,
        phone_hash: audit.phone_hash,
        user_id: userId ?? null,
      });
      await this.logAuthFailure(phone, `login_locked_${lock.scope}`, userId);
    }
  }

  /**
   * bcrypt narxi joriydan (12) past — yangi xesh. Sessiyalarning parol izi
   * (`password_fp`, xeshdan olinadi) AYNI tranzaksiyada yangilanadi, aks
   * holda qayta xeshlash foydalanuvchining boshqa qurilmalarini «parol
   * almashdi» deb chiqarib yuborardi. Xato — login'ni to'xtatmaydi.
   */
  private async rehashIfNeeded(user: User, password: string): Promise<void> {
    try {
      if (!this.bcryptEncryption.needsRehash(user.password)) return;
      const oldHash = user.password;
      const newHash = await this.bcryptEncryption.encrypt(password);
      const updated = await this.users.manager.transaction(async (manager) => {
        const result = await manager.update(
          User,
          { id: user.id, password: oldHash },
          { password: newHash },
        );
        if (!result.affected) return false;
        await this.sessions.repointPasswordFingerprint(
          manager,
          user.id,
          oldHash,
          newHash,
        );
        return true;
      });
      if (updated) user.password = newHash;
    } catch (error) {
      this.logger.warn(
        `Parol qayta xeshlanmadi (user ${user.id}): ${(error as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * Mavjud parol yangi siyosatga mos emas → `must_change_password = true`
   * (login baribir davom etadi). Bayroq bu yerda faqat QO'YILADI — tushirish
   * faqat foydalanuvchi parolni o'zi almashtirganda.
   */
  private async flagWeakPassword(user: User, password: string): Promise<void> {
    if (user.must_change_password) return;
    if (
      isPasswordPolicyCompliant(password, {
        role: user.role,
        phone: user.phone_number,
      })
    ) {
      return;
    }
    try {
      await this.users.update({ id: user.id }, { must_change_password: true });
      user.must_change_password = true;
    } catch (error) {
      this.logger.warn(
        `must_change_password yozilmadi (user ${user.id}): ${(error as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * Tasdiqlangan foydalanuvchiga sessiya (token juftligi). Parol login'i va
   * OTP login'i (OtpService) shu bitta yo'ldan o'tadi.
   *
   * (Elchi Pochta #3) Login `user_sessions` da sessiya ochadi —
   * foydalanuvchining boshqa qurilmalaridagi sessiyalar YOPILMAYDI. Shu
   * qurilma (`X-Device-Id`) sessiyasi aniq yopilmagan bo'lsa (masalan,
   * refresh muddati o'tgan) — yangi qator emas, o'sha sessiya yangilanadi
   * (`AuthSessionService.open`).
   */
  async sessionForUser(user: User, method: 'password' | 'otp' = 'password') {
    const tokens = await this.issueTokens(user, method);
    const loginEntry = {
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGIN,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
      ...(method === 'otp' ? { metadata: { method } } : {}),
      // "<Ism> tizimga kirdi" (2WRzdWpZ); mijozda ism o'rniga rol (PII).
      description: ActivityDescribeUz.login({
        name: user.name,
        role: user.role,
        method,
      }),
    };
    // i6Nyedea — AYNI qurilma/IP'dan N daqiqa ichidagi takroriy login yangi
    // qator yaratmaydi (`ACTIVITY_LOG_LOGIN_DEDUP_MINUTES`, sukut 10; 0 — o'chiq).
    if (this.activityLogMaintenance) {
      await this.activityLogMaintenance.logCoalesced(
        loginEntry,
        resolveLoginDedupWindowMs(),
      );
    } else {
      await this.activityLog.log(loginEntry);
    }
    return {
      statusCode: 200,
      message: 'success',
      user: this.sanitize(user),
      // (NDmZMzCP) Zaif / vaqtinchalik parol — keyingi qadam parolni almashtirish.
      must_change_password: Boolean(user.must_change_password),
      ...tokens,
      access_token_expires_at: tokens.accessTokenExpiresAt,
      refresh_token_expires_at: tokens.refreshTokenExpiresAt,
      refresh_token_warn_at: tokens.refreshTokenWarnAt,
    };
  }

  /**
   * (xC88d8kH #2) `POST /auth/telegram` — Mini App initData imzosi (bot
   * tokeni bilan HMAC) va `auth_date` (≤5 daqiqa) tekshiriladi, keyin
   * `users.telegram_id` bo'yicha xodim topiladi. Natija — odatdagi Elchi
   * access JWT, lekin QISQA (TELEGRAM_ACCESS_TOKEN_TIME, sukut 30m) va
   * refresh BERILMAYDI. Bot tokeni hech qachon javob yoki xatoda chiqmaydi.
   */
  async telegramLogin(data: { init_data?: unknown }) {
    const initData = typeof data?.init_data === 'string' ? data.init_data : '';
    const botToken = String(
      this.configService.get<string>('TELEGRAM_BOT_TOKEN') ?? '',
    ).trim();
    const verified = verifyTelegramInitData(initData, botToken);
    if (!verified.ok) {
      throw new RpcException({
        statusCode: verified.reason === 'no_bot_token' ? 503 : 401,
        message:
          verified.reason === 'expired'
            ? "initData eskirgan — Mini App'ni qayta oching"
            : verified.reason === 'no_bot_token'
              ? 'Telegram bot sozlanmagan'
              : "initData imzosi noto'g'ri",
      });
    }
    return this.telegramAccessToken(verified.user.id, 'mini_app');
  }

  /**
   * (xC88d8kH #3) Telegram aktori nomidan qisqa muddatli access token —
   * Mini App (`telegramLogin`) va bot (ichki RMQ `identity.auth.telegram_actor`,
   * notification-service webhook sekreti tekshirilgan update'dan) uchun.
   * Bot shu token bilan MAVJUD gateway endpointlarini chaqiradi — parallel
   * "qulay" endpoint yo'q, RBAC bitta joyda. Bog'lanmagan / nofaol / mijoz /
   * investor / noaniq (bir nechta akkaunt) → 401.
   */
  async telegramAccessToken(telegramId: string, via: 'mini_app' | 'bot') {
    const id = String(telegramId ?? '').trim();
    const rows = /^\d{1,20}$/.test(id)
      ? await this.users.find({
          where: { telegram_id: id, isDeleted: false, status: Status.ACTIVE },
          take: 2,
        })
      : [];
    const user = rows.length === 1 ? rows[0] : null;
    if (!user || [Roles.CUSTOMER, Roles.INVESTOR].includes(user.role)) {
      throw new RpcException({
        statusCode: 401,
        message:
          "Telegram akkaunt Elchi'ga bog'lanmagan — avval kabinetdan «Telegram'ni ulash» ni bosing",
      });
    }
    const payload = await this.createTokenPayload(user);
    const accessToken = await this.jwtService.signAsync(
      { ...payload, auth: 'telegram' },
      {
        expiresIn: (this.configService.get<string>(
          'TELEGRAM_ACCESS_TOKEN_TIME',
        ) ?? '30m') as StringValue,
      },
    );
    if (via === 'mini_app') {
      await this.activityLog.log({
        entity_type: 'Auth',
        entity_id: user.id,
        action: ActivityAction.LOGIN,
        user_id: user.id,
        user_name: user.name,
        user_role: user.role,
        metadata: { method: 'telegram' },
      });
    }
    return {
      statusCode: 200,
      message: 'success',
      user: this.sanitize(user),
      accessToken,
      access_token_expires_at: this.extractExpMs(accessToken),
    };
  }

  async validateUser(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      throw new RpcException(errorRes('User not found', 401));
    }
    if (user.status !== Status.ACTIVE) {
      throw new RpcException(errorRes('User not found', 401));
    }

    return {
      statusCode: 200,
      message: 'success',
      user: this.sanitize(user),
    };
  }

  async refresh(dto: RefreshDto) {
    const refreshSecret = this.configService.get<string>('REFRESH_TOKEN_KEY');
    if (!refreshSecret) {
      throw new RpcException(errorRes('Refresh secret not configured', 401));
    }

    let payload: { sub: string; username: string; iat?: number };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        username: string;
        iat?: number;
      }>(dto.refreshToken, { secret: refreshSecret });
    } catch {
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const user = await this.users.findOne({
      where: { id: payload.sub, isDeleted: false },
    });
    if (
      !user ||
      user.username !== payload.username ||
      user.status !== Status.ACTIVE
    ) {
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const now = new Date();
    const presentedHash = hashRefreshToken(dto.refreshToken);
    const refreshTokenExpiresAt = this.extractExpMs(dto.refreshToken);

    // (Elchi Pochta #3) Sessiya — token hashi bo'yicha. Topilmasa va hash
    // ESKI `admins.refresh_token` ga mos bo'lsa — deploy'dan oldin kirgan
    // foydalanuvchi: sessiya qatori hozir yaratiladi, u chiqarib
    // yuborilmaydi. Yopilgan qator bor bo'lsa legacy yo'liga HECH QACHON
    // o'tilmaydi (logout qilingan token qayta tirilmaydi).
    let session = await this.sessions.findByHash(presentedHash);
    if (!session && user.refresh_token === presentedHash) {
      session = await this.sessions.adoptLegacy({
        user,
        refreshToken: dto.refreshToken,
        expiresAt: new Date(
          refreshTokenExpiresAt ?? now.getTime() + DEFAULT_REFRESH_TTL_MS,
        ),
        createdAt:
          typeof payload.iat === 'number'
            ? new Date(payload.iat * 1000)
            : undefined,
        now,
      });
    }

    if (!session) {
      // Imzo to'g'ri, lekin bunday sessiya yo'q: deploy'dan oldin boshqa
      // login bilan almashtirilgan token yoki muddati o'tib tozalangan qator.
      // RBAC-10 dagidek boshqa sessiyalarga TEGILMAYDI — faqat shu token 401.
      await this.logRefreshRejected(user, 'refresh_session_not_found');
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const rejected = this.sessions.rejectReason(session, user, now);
    if (rejected) {
      if (rejected === 'reset' || rejected === 'password_changed') {
        // Xavfsizlik hodisasi allaqachon amal qilgan — qatorga ham yoziladi.
        await this.sessions.revokeOwn(
          user.id,
          { sessionId: session.id },
          'security_reset',
          now,
        );
      }
      await this.logRefreshRejected(
        user,
        rejected === 'expired'
          ? 'refresh_session_expired'
          : 'refresh_session_revoked',
        { session_id: session.id, cause: rejected },
      );
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    // `revoked_at IS NULL` sharti bilan: shu orada logout bo'lgan bo'lsa 401.
    if (!(await this.sessions.touch(session.id, now))) {
      await this.logRefreshRejected(user, 'refresh_session_revoked', {
        session_id: session.id,
        cause: 'revoked',
      });
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    // Refresh token ROTATSIYA QILINMAYDI (avvalgidek): sessiya muddati —
    // login + REFRESH_TOKEN_TIME. Bitta brauzerdagi barcha tablar bitta
    // httpOnly cookie'ni bo'lishadi — rotatsiya ular orasida poyga
    // (bir tab yangi tokenni olib, boshqasi eskisi bilan 401) keltirardi.
    const accessToken = await this.issueAccessToken(user, session.id);
    const refreshTokenWarnAt =
      refreshTokenExpiresAt !== null
        ? refreshTokenExpiresAt - 15 * 60 * 1000
        : null;

    return {
      statusCode: 200,
      message: 'success',
      user: this.sanitize(user),
      ...accessToken,
      refreshTokenExpiresAt,
      refreshTokenWarnAt,
      access_token_expires_at: accessToken.accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
      refresh_token_warn_at: refreshTokenWarnAt,
    };
  }

  /** Refresh rad etildi — xavfsizlik izi (telefon yo'q, faqat id va sabab). */
  private async logRefreshRejected(
    user: User,
    reason:
      | 'refresh_session_not_found'
      | 'refresh_session_revoked'
      | 'refresh_session_expired',
    extra: { session_id?: string; cause?: SessionRejectReason } = {},
  ): Promise<void> {
    this.logger.warn(
      `Refresh rejected for user ${user.id}: ${reason}${extra.cause ? ` (${extra.cause})` : ''}`,
    );
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.AUTH_FAILURE,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
      metadata: { reason, ...extra },
      description: ActivityDescribeUz.authFailure(reason),
    });
  }

  /**
   * (Elchi Pochta #3) FAQAT joriy sessiya yopiladi — boshqa qurilmalar
   * ishlashda davom etadi. Joriy sessiya: access token `sid` claim'i
   * (imzolangan) va/yoki shu brauzerning refresh cookie'si. Ikkalasi ham
   * faqat SHU foydalanuvchining qatorlariga qo'llanadi.
   */
  async logout(
    userId: string,
    target: { sessionId?: string | null; refreshToken?: string | null } = {},
  ) {
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });

    if (!user) {
      throw new RpcException(errorRes('User not found', 401));
    }

    const refreshTokenHash =
      typeof target.refreshToken === 'string' && target.refreshToken
        ? hashRefreshToken(target.refreshToken)
        : null;
    const sessionId = isSessionId(target.sessionId) ? target.sessionId : null;
    const revoked = await this.sessions.revokeOwn(
      user.id,
      { sessionId, refreshTokenHash },
      'logout',
    );

    // Eski ustunda shu sessiyaning hashi tursa u ham tozalanadi (legacy
    // token yoki rollback'da yopilgan sessiya tirilmasin). Shartli UPDATE —
    // shu orada yozilgan yangi login hashi o'chmaydi.
    if (user.refresh_token) {
      const legacyIsThisSession =
        user.refresh_token === refreshTokenHash ||
        (sessionId !== null &&
          (await this.sessions.findByHash(user.refresh_token))?.id ===
            sessionId);
      if (legacyIsThisSession) {
        await this.users.update(
          { id: user.id, refresh_token: user.refresh_token },
          { refresh_token: null },
        );
      }
    }

    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGOUT,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
      metadata: { sessions_revoked: revoked },
    });

    // Shu sessiya(lar) id si — gateway o'z keshida darhol «yopilgan» deb
    // belgilaydi: shu brauzerning boshqa tablaridagi access token ham
    // muddati tugashini kutmay 401 oladi. Faqat SHU foydalanuvchiniki.
    const sessionIds = await this.sessions.ownSessionIds(user.id, {
      sessionId,
      refreshTokenHash,
    });
    return successRes(
      { session_ids: sessionIds },
      200,
      'Logged out successfully',
    );
  }

  /**
   * (Elchi Pochta #3) `GET /auth/sessions` — akkaunt egasining O'Z ochiq
   * sessiyalari: faollar soni, qurilma/IP, birinchi va oxirgi login, oxirgi
   * faollik, holat (`active` / `expired` — «Qayta kirish kerak»), joriy
   * sessiya belgisi. Boshqa foydalanuvchilar yoki tizim bo'yicha umumiy
   * son/ro'yxat qaytmaydi — `userId` faqat gateway'dagi JWT `sub` dan.
   */
  async listSessions(data: {
    userId: string;
    sessionId?: string | null;
  }): Promise<{
    statusCode: number;
    message: string;
    data: OwnSessionsWithLock;
  }> {
    const user = await this.users.findOne({
      where: { id: data.userId, isDeleted: false },
    });
    if (!user || user.status !== Status.ACTIVE) {
      throw new RpcException(errorRes('User not found', 401));
    }
    const now = new Date();
    const list = await this.sessions.listOwn(user, data.sessionId ?? null, now);
    // (2026-10-23) 48 soatlik qulf — joriy sessiyaning `created_at` i
    // (`first_logged_in_at`) bo'yicha, revoke endpointlari bilan AYNI qoida.
    // Joriy sessiya ro'yxatda yo'q (`sid` siz token) — yopa olmaydi
    // (revoke-others baribir 400), vaqt noma'lum → `null`.
    const current = list.sessions.find((row) => row.current) ?? null;
    const lock = current
      ? sessionRevokeLock(current.first_logged_in_at, this.revokeLockMs(), now)
      : null;
    return successRes(
      {
        ...list,
        can_revoke_others: lock?.allowed ?? false,
        revoke_available_at: lock?.available_at?.toISOString() ?? null,
      },
      200,
      'success',
    ) as {
      statusCode: number;
      message: string;
      data: OwnSessionsWithLock;
    };
  }

  /** `SESSION_REVOKE_LOCK_HOURS` (sukut 48; 0 — o'chiq) → ms. Har chaqiruvda. */
  private revokeLockMs(): number {
    return resolveSessionRevokeLockMs(
      this.configService.get<unknown>('SESSION_REVOKE_LOCK_HOURS'),
    );
  }

  /**
   * (Elchi Pochta #3, 2026-10-23) "Telegram'dagidek": yaratilganiga
   * SESSION_REVOKE_LOCK_HOURS (48) to'lmagan sessiya BOSHQA sessiyalarni
   * yopa olmaydi — 403, mashina kodi `SESSION_TOO_NEW` va `available_at`
   * (ISO; gateway konvertiga `PUBLIC_ERROR_CODES` orqali o'tadi). Eski
   * sessiya yangisini yopa oladi; logout va parol almashtirish qulfsiz.
   */
  private assertMayRevokeOthers(
    current: Pick<UserSession, 'created_at'>,
    now = new Date(),
  ): void {
    const lock = sessionRevokeLock(
      current.created_at,
      this.revokeLockMs(),
      now,
    );
    if (lock.allowed || !lock.available_at) return;
    throw new RpcException({
      ...errorRes(
        `Xavfsizlik uchun yangi qurilmadan boshqa sessiyalarni chiqarib bo'lmaydi — ${formatTashkentMinuteCeil(lock.available_at)} (Toshkent) dan keyin mumkin`,
        403,
      ),
      code: SESSION_TOO_NEW,
      available_at: lock.available_at.toISOString(),
    });
  }

  /**
   * (Elchi Pochta #3) `DELETE /auth/sessions/:id` — egasi BOSHQA qurilmadagi
   * bitta sessiyasini yopadi. Kim — faqat gateway'dagi JWT `sub`, joriy
   * sessiya — JWT `sid`. Joriy sessiya bu yerdan yopilmaydi («Chiqish»
   * refresh cookie'ni ham tozalaydi). Begona / yo'q / allaqachon yopilgan
   * sessiya — bir xil 404 (boshqa odamning sessiyasi borligi oshkor
   * qilinmaydi).
   *
   * (2026-10-23) 48 soatlik qulf: joriy sessiya yaratilganiga
   * SESSION_REVOKE_LOCK_HOURS to'lmagan bo'lsa — 403 `SESSION_TOO_NEW`
   * (nishon eski yoki yangi bo'lishidan qat'i nazar); qulf yoqilganda `sid`
   * siz token — 400.
   */
  async revokeSession(data: {
    userId: string;
    sessionId?: string | null;
    currentSessionId?: string | null;
  }): Promise<RevokedSessionsResponse> {
    if (!isSessionId(data.sessionId)) {
      throw new RpcException(errorRes("Sessiya identifikatori noto'g'ri", 400));
    }
    const target = data.sessionId.toLowerCase();
    const current = isSessionId(data.currentSessionId)
      ? data.currentSessionId.toLowerCase()
      : null;
    if (target === current) {
      throw new RpcException(
        errorRes(
          "Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan foydalaning",
          400,
        ),
      );
    }
    // (2026-10-23) Qulf yoqilgan bo'lsa `sid` siz token (Telegram Mini App,
    // eski) yopa olmaydi: uning yoshini bilib bo'lmaydi — aks holda qulfni
    // aylanib o'tish yo'li bo'lardi. Qulf o'chiq (0) — avvalgidek ruxsat.
    if (current === null && this.revokeLockMs() > 0) {
      throw new RpcException(errorRes(CURRENT_SESSION_UNKNOWN, 400));
    }
    const { user, session } = await this.loadSessionOwner(data.userId, current);
    if (session) this.assertMayRevokeOthers(session);

    const revokedIds = await this.sessions.revokeOwnById(
      user.id,
      target,
      'revoked_by_owner',
    );
    if (!revokedIds.length) {
      throw new RpcException(
        errorRes('Sessiya topilmadi yoki allaqachon yopilgan', 404),
      );
    }

    // Eski ustunda yopilgan sessiyaning hashi tursa — tozalanadi (rollback'da
    // yoki legacy yo'lida tirilmasin).
    await this.clearLegacyRefreshColumn(
      user,
      (owner) => owner !== null && revokedIds.includes(owner.id),
    );
    await this.logOwnerRevoke(user, 'session', revokedIds);
    return successRes(
      { revoked: revokedIds.length, session_ids: revokedIds },
      200,
      'Sessiya yopildi',
    ) as RevokedSessionsResponse;
  }

  /**
   * (Elchi Pochta #3) `POST /auth/sessions/revoke-others` — joriy sessiyadan
   * boshqa BARCHA sessiyalar yopiladi (boshqa qurilmalar chiqib ketadi),
   * joriy qurilma ishlashda davom etadi. `sid` siz token (deploy'dan oldingi
   * yoki Telegram) — joriy sessiyani aniqlab bo'lmaydi → 400 (aks holda
   * so'rovchining o'zi ham chiqib ketardi). Yopiladigan sessiya bo'lmasa ham
   * 200 (`revoked: 0`). (2026-10-23) Joriy sessiya 48 soatdan yosh — 403
   * `SESSION_TOO_NEW` (hech narsa yopilmaydi).
   */
  async revokeOtherSessions(data: {
    userId: string;
    currentSessionId?: string | null;
  }): Promise<RevokedSessionsResponse> {
    if (!isSessionId(data.currentSessionId)) {
      throw new RpcException(errorRes(CURRENT_SESSION_UNKNOWN, 400));
    }
    const current = data.currentSessionId.toLowerCase();
    const { user, session } = await this.loadSessionOwner(data.userId, current);
    if (session) this.assertMayRevokeOthers(session);

    const revokedIds = await this.sessions.revokeOwnExcept(
      user.id,
      current,
      'revoked_by_owner',
    );

    // Eski ustunda joriy sessiyadan BOSHQA hash bo'lsa — tozalanadi:
    // hali qatori yaratilmagan (deploy'dan oldin kirgan) qurilma ham
    // `adoptLegacy` orqali qaytib kira olmasin.
    await this.clearLegacyRefreshColumn(
      user,
      (owner) => owner === null || owner.id !== current,
    );
    await this.logOwnerRevoke(user, 'others', revokedIds);
    return successRes(
      { revoked: revokedIds.length, session_ids: revokedIds },
      200,
      revokedIds.length
        ? 'Boshqa sessiyalardan chiqildi'
        : "Boshqa faol sessiya yo'q",
    ) as RevokedSessionsResponse;
  }

  /**
   * (Elchi Pochta #3) Ichki RMQ (faqat gateway `JwtStrategy` / socket): `sid`
   * li access token sessiyasi hozir yaroqlimi. (NDmZMzCP, 2026-10-26) Endi
   * TO'LIQ: qator ochiq + foydalanuvchi faol (bloklanmagan, o'chirilmagan) +
   * epoch joriy (rol / telefon almashmagan) — `AuthSessionService.isUsable`.
   * Bloklangan foydalanuvchining access tokeni gateway keshi yangilanishi
   * bilan (≤ 30 soniya) to'xtaydi, soatlik tozalashni kutmaydi.
   */
  async sessionState(data: {
    userId?: unknown;
    sessionId?: unknown;
  }): Promise<{ active: boolean }> {
    const userId =
      typeof data?.userId === 'string' || typeof data?.userId === 'number'
        ? String(data.userId)
        : '';
    if (!userId || !isSessionId(data?.sessionId)) return { active: false };
    const session = await this.sessions.findOpenRow(userId, data.sessionId);
    if (!session) return { active: false };
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });
    return { active: await this.sessions.isUsable(session, user) };
  }

  /**
   * Sessiyalarni boshqarish so'rovchisi: faol foydalanuvchi va (bo'lsa) joriy
   * sessiyasi hali ochiq. Yopilgan sessiya tokeni (masalan, egasi chiqarib
   * yuborgan qurilma, gateway keshi yangilanguncha) egasining boshqa
   * sessiyalarini yopa olmaydi. Joriy sessiya qatori (`created_at` bilan —
   * 48 soatlik qulf uchun) ham qaytadi; `sid` siz — `null`.
   */
  private async loadSessionOwner(
    userId: string,
    currentSessionId: string | null,
  ): Promise<{
    user: User;
    session: Pick<UserSession, 'id' | 'created_at'> | null;
  }> {
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });
    if (!user || user.status !== Status.ACTIVE) {
      throw new RpcException(errorRes('User not found', 401));
    }
    if (currentSessionId === null) return { user, session: null };
    const session = await this.sessions.findOpen(user.id, currentSessionId);
    if (!session) {
      throw new RpcException(errorRes('Session revoked', 401));
    }
    return { user, session };
  }

  /**
   * `admins.refresh_token` (eski bitta-sessiya ustuni) — `shouldClear` hash
   * egasi bo'lgan sessiya qatorini (yo'q bo'lsa `null`) oladi. logout'dagi
   * kabi SHARTLI UPDATE: shu orada yozilgan yangi login hashi o'chmaydi.
   */
  private async clearLegacyRefreshColumn(
    user: User,
    shouldClear: (owner: { id: string } | null) => boolean,
  ): Promise<void> {
    if (!user.refresh_token) return;
    const owner = await this.sessions.findByHash(user.refresh_token);
    if (!shouldClear(owner ? { id: String(owner.id).toLowerCase() } : null)) {
      return;
    }
    await this.users.update(
      { id: user.id, refresh_token: user.refresh_token },
      { refresh_token: null },
    );
  }

  private async logOwnerRevoke(
    user: User,
    scope: 'session' | 'others',
    sessionIds: string[],
  ): Promise<void> {
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGOUT,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
      metadata: {
        scope,
        sessions_revoked: sessionIds.length,
        session_ids: sessionIds,
      },
      description: ActivityDescribeUz.sessionsRevokedByOwner(
        scope,
        sessionIds.length,
      ),
    });
  }

  /**
   * Eski (bitta sessiya) ustun — eng oxirgi login hashi. Endi tekshiruv
   * `user_sessions` da; ustun faqat rollback uchun yozilib turadi (eski kod
   * qaytarilsa oxirgi login ishlashda davom etadi).
   */
  private async saveRefreshToken(userId: string, refreshToken: string) {
    await this.users.update(
      { id: userId },
      { refresh_token: hashRefreshToken(refreshToken) },
    );
  }

  private async issueTokens(user: User, method: 'password' | 'otp') {
    const payload = await this.createTokenPayload(user);

    const refreshToken = await this.jwtService.signAsync(
      // `jti` — har refresh token noyob: bir soniyadagi ikki login (ikki
      // marta bosish) AYNI JWT'ni berardi va UNIQUE hash to'qnashardi.
      { ...payload, jti: randomUUID() },
      {
        secret: this.configService.get<string>('REFRESH_TOKEN_KEY'),
        expiresIn: (this.configService.get<string>('REFRESH_TOKEN_TIME') ??
          DEFAULT_REFRESH_TOKEN_TIME) as StringValue,
      },
    );

    const refreshTokenExpiresAt = this.extractExpMs(refreshToken);
    const session = await this.sessions.open({
      user,
      refreshToken,
      method,
      expiresAt: new Date(
        refreshTokenExpiresAt ?? Date.now() + DEFAULT_REFRESH_TTL_MS,
      ),
    });
    await this.saveRefreshToken(user.id, refreshToken);

    const accessTokenResult = await this.signAccessToken(
      this.withPasswordChangeClaim(payload, user),
      session.id,
    );
    const refreshTokenWarnAt =
      refreshTokenExpiresAt !== null
        ? refreshTokenExpiresAt - 15 * 60 * 1000
        : null;

    return {
      ...accessTokenResult,
      refreshToken,
      refreshTokenExpiresAt,
      refreshTokenWarnAt,
    };
  }

  private async issueAccessToken(user: User, sessionId: string) {
    return this.signAccessToken(
      this.withPasswordChangeClaim(await this.createTokenPayload(user), user),
      sessionId,
    );
  }

  /**
   * (NDmZMzCP) `must_change_password` → access token'da `pwd_change: true`
   * (faqat parol/OTP sessiyalari; Telegram tokenlariga qo'shilmaydi —
   * ular parol bilan olinmaydi). Gateway `PasswordChangeGuard` shu claim
   * bo'yicha tokenni parol almashtirish oqimi bilan cheklaydi
   * (`PASSWORD_CHANGE_GATE=on`). Bayroq yo'q — token avvalgidek.
   * Parol almashtirilgach `POST /auth/refresh` claim'siz token beradi.
   */
  private withPasswordChangeClaim<T extends object>(
    payload: T,
    user: Pick<User, 'must_change_password'>,
  ): T & { pwd_change?: true } {
    return user.must_change_password
      ? { ...payload, pwd_change: true }
      : payload;
  }

  /**
   * `sid` — sessiya id si (`user_sessions.id`): logout aynan shu sessiyani
   * yopadi, ro'yxat "joriy" sessiyani belgilaydi. Gateway `JwtStrategy`
   * payload'ni o'zgartirmay uzatadi; boshqa iste'molchilar claim'ga
   * qaramaydi. Telegram tokenlarida `sid` yo'q (sessiya emas).
   */
  private async signAccessToken(
    payload: Awaited<ReturnType<AuthService['createTokenPayload']>> & {
      pwd_change?: true;
    },
    sessionId: string,
  ) {
    const accessToken = await this.jwtService.signAsync({
      ...payload,
      sid: sessionId,
    });

    return {
      accessToken,
      accessTokenExpiresAt: this.extractExpMs(accessToken),
    };
  }

  private async createTokenPayload(user: User) {
    const branchId = await this.resolveBranchId(user.id);

    return {
      sub: user.id,
      username: user.username,
      // fQi6NNUL / y8CxCtcK — gateway faoliyat jurnali aktyorining ismi
      // (`requestContext.setActor` → `activity_logs.user_name`). Faqat
      // foydalanuvchining o'z ismi; telefon/boshqa PII tokenga QO'SHILMAYDI.
      name: user.name ?? null,
      roles: [user.role],
      branch_id: branchId,
    };
  }

  private extractExpMs(token: string): number | null {
    const decoded = this.jwtService.decode(token);
    if (!decoded || typeof decoded.exp !== 'number') {
      return null;
    }
    return decoded.exp * 1000;
  }

  private sanitize(user: User) {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      phone_number: user.phone_number,
      role: user.role,
      status: user.status,
      // (NDmZMzCP) `true` — FE parolni almashtirish ekraniga yo'naltiradi.
      must_change_password: Boolean(user.must_change_password),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
