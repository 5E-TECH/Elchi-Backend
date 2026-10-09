import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import type { StringValue } from 'ms';
import { User } from '../entities/user.entity';
import { BcryptEncryption } from '../../../../libs/common/helpers/bcrypt';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import {
  ActivityAction,
  ActivityDescribeUz,
  ActivityLogService,
  Status,
  computeHmacSignature,
  normalizeUzPhone,
  rmqSend,
} from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';

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
   */
  async sessionForUser(user: User, method: 'password' | 'otp' = 'password') {
    const tokens = await this.issueTokens(user);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
    await this.activityLog.log({
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
    });
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

    let payload: { sub: string; username: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        username: string;
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

    const presentedHash = this.hashRefreshToken(dto.refreshToken);

    if (!user.refresh_token) {
      // Already logged out (or never logged in on this token). 401.
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    if (user.refresh_token !== presentedHash) {
      // The signature is valid but this is not the active token stored for
      // the user, so it is rejected (401) — a stale token is never accepted.
      //
      // RBAC-10: the stored session is NOT wiped any more. Refresh tokens are
      // not rotated and every login overwrites the single stored hash, so a
      // mismatching token is a SUPERSEDED login (another device/browser logged
      // in later), not a replay of a rotated token. Wiping the hash here
      // logged out the newer, legitimate session as well — both devices were
      // kicked within ~15 minutes of every login. Explicit revocations
      // (logout, password/phone change, deactivation) still null the hash or
      // fail the status check above. Per-device sessions are a separate
      // redesign (C15 decision).
      this.logger.warn(
        `Superseded refresh token presented for user ${user.id} — rejected, current session kept`,
      );
      await this.activityLog.log({
        entity_type: 'Auth',
        entity_id: user.id,
        action: ActivityAction.AUTH_FAILURE,
        user_id: user.id,
        user_name: user.name,
        user_role: user.role,
        metadata: {
          reason: 'refresh_token_superseded',
          session_invalidated: false,
        },
        description: ActivityDescribeUz.authFailure('refresh_token_superseded'),
      });
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const accessToken = await this.issueAccessToken(user);
    const refreshTokenExpiresAt = this.extractExpMs(dto.refreshToken);
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

  async logout(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });

    if (!user) {
      throw new RpcException(errorRes('User not found', 401));
    }

    user.refresh_token = null;
    await this.users.save(user);

    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGOUT,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
    });

    return successRes({}, 200, 'Logged out successfully');
  }

  /**
   * Refresh tokens are stored as SHA-256 hex so a DB leak does not expose
   * usable session tokens. The plaintext value only lives in transit/memory.
   */
  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async saveRefreshToken(userId: string, refreshToken: string) {
    await this.users.update(
      { id: userId },
      { refresh_token: this.hashRefreshToken(refreshToken) },
    );
  }

  private async issueTokens(user: User) {
    const accessTokenResult = await this.issueAccessToken(user);
    const payload = await this.createTokenPayload(user);

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('REFRESH_TOKEN_KEY'),
      expiresIn: (this.configService.get<string>('REFRESH_TOKEN_TIME') ??
        '7d') as StringValue,
    });

    const refreshTokenExpiresAt = this.extractExpMs(refreshToken);
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

  private async issueAccessToken(user: User) {
    const payload = await this.createTokenPayload(user);
    const accessToken = await this.jwtService.signAsync(payload);

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
