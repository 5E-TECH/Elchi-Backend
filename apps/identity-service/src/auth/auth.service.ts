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
  type SessionRejectReason,
  hashRefreshToken,
  isSessionId,
} from './auth-session.service';
import { BcryptEncryption } from '../../../../libs/common/helpers/bcrypt';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import {
  ActivityAction,
  ActivityDescribeUz,
  ActivityLogMaintenanceService,
  ActivityLogService,
  Roles,
  Status,
  computeHmacSignature,
  normalizeUzPhone,
  resolveLoginDedupWindowMs,
  rmqSend,
  verifyTelegramInitData,
} from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';

/** `REFRESH_TOKEN_TIME` sukuti (prod: 1d) va JWT `exp` o'qilmasa zaxira muddat. */
const DEFAULT_REFRESH_TOKEN_TIME = '1d';
const DEFAULT_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

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

  async login(dto: LoginDto) {
    const user = await this.users.findOne({
      where: { phone_number: dto.phone_number, isDeleted: false },
    });
    if (!user) {
      await this.logAuthFailure(dto.phone_number, 'user_not_found');
      throw new RpcException(errorRes('Invalid credentials', 401));
    }
    if (user.status !== Status.ACTIVE) {
      await this.logAuthFailure(dto.phone_number, 'inactive', user.id);
      throw new RpcException(errorRes('Invalid credentials', 401));
    }

    const isMatch = await this.bcryptEncryption.compare(
      dto.password,
      user.password,
    );
    if (!isMatch) {
      await this.logAuthFailure(dto.phone_number, 'bad_password', user.id);
      throw new RpcException(errorRes('Invalid credentials', 401));
    }

    return this.sessionForUser(user);
  }

  /**
   * Tasdiqlangan foydalanuvchiga sessiya (token juftligi). Parol login'i va
   * OTP login'i (OtpService) shu bitta yo'ldan o'tadi.
   *
   * (Elchi Pochta #3) Har login `user_sessions` da YANGI qator ochadi —
   * foydalanuvchining boshqa qurilmalaridagi sessiyalar endi YOPILMAYDI.
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

    return successRes({}, 200, 'Logged out successfully');
  }

  /**
   * (Elchi Pochta #3) `GET /auth/sessions` — akkaunt egasining O'Z faol
   * sessiyalari: soni, qurilma/IP, login va oxirgi faollik vaqti, joriy
   * sessiya belgisi. Boshqa foydalanuvchilar yoki tizim bo'yicha umumiy
   * son/ro'yxat qaytmaydi — `userId` faqat gateway'dagi JWT `sub` dan.
   */
  async listSessions(data: { userId: string; sessionId?: string | null }) {
    const user = await this.users.findOne({
      where: { id: data.userId, isDeleted: false },
    });
    if (!user || user.status !== Status.ACTIVE) {
      throw new RpcException(errorRes('User not found', 401));
    }
    return successRes(
      await this.sessions.listOwn(user, data.sessionId ?? null),
      200,
      'success',
    );
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

    const accessTokenResult = await this.signAccessToken(payload, session.id);
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
      await this.createTokenPayload(user),
      sessionId,
    );
  }

  /**
   * `sid` — sessiya id si (`user_sessions.id`): logout aynan shu sessiyani
   * yopadi, ro'yxat "joriy" sessiyani belgilaydi. Gateway `JwtStrategy`
   * payload'ni o'zgartirmay uzatadi; boshqa iste'molchilar claim'ga
   * qaramaydi. Telegram tokenlarida `sid` yo'q (sessiya emas).
   */
  private async signAccessToken(
    payload: Awaited<ReturnType<AuthService['createTokenPayload']>>,
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
