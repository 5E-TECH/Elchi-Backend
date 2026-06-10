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
import { ActivityAction, ActivityLogService, Status, rmqSend } from '@app/common';
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

  /** Record a failed login attempt for the security audit trail. */
  private async logAuthFailure(
    phone: string,
    reason: string,
    userId?: string,
  ): Promise<void> {
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: userId ?? phone,
      action: ActivityAction.AUTH_FAILURE,
      user_id: userId ?? null,
      metadata: { phone_number: phone, reason },
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

    const isMatch = await this.bcryptEncryption.compare(dto.password, user.password);
    if (!isMatch) {
      await this.logAuthFailure(dto.phone_number, 'bad_password', user.id);
      throw new RpcException(errorRes('Invalid credentials', 401));
    }

    const tokens = await this.issueTokens(user);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGIN,
      user_id: user.id,
      user_name: user.name,
      user_role: user.role,
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
      payload = await this.jwtService.verifyAsync<{ sub: string; username: string }>(
        dto.refreshToken,
        { secret: refreshSecret },
      );
    } catch {
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const user = await this.users.findOne({
      where: { id: payload.sub, isDeleted: false },
    });
    if (!user || user.username !== payload.username || user.status !== Status.ACTIVE) {
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const presentedHash = this.hashRefreshToken(dto.refreshToken);

    if (!user.refresh_token) {
      // Already logged out (or never logged in on this token). 401.
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    if (user.refresh_token !== presentedHash) {
      // Reuse detected: signature is valid but this token is no longer the
      // active one for the user. Either an attacker is replaying a stolen
      // token after a legitimate rotation, or the legitimate user is using
      // a stale token. In both cases the safe response is to invalidate the
      // entire session — the real user can log in again.
      this.logger.warn(
        `Refresh token reuse detected for user ${user.id} — invalidating session`,
      );
      user.refresh_token = null;
      await this.users.save(user);
      await this.activityLog.log({
        entity_type: 'Auth',
        entity_id: user.id,
        action: ActivityAction.AUTH_FAILURE,
        user_id: user.id,
        user_name: user.name,
        user_role: user.role,
        metadata: { reason: 'refresh_token_reuse', session_invalidated: true },
      });
      throw new RpcException(errorRes('Invalid refresh token', 401));
    }

    const tokens = await this.issueTokens(user);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
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
    const branchId = await this.resolveBranchId(user.id);

    const payload: Record<string, unknown> = {
      sub: user.id,
      username: user.username,
      roles: [user.role],
      branch_id: branchId,
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('REFRESH_TOKEN_KEY'),
      expiresIn: (this.configService.get<string>('REFRESH_TOKEN_TIME') ??
        '7d') as StringValue,
    });

    const accessTokenExpiresAt = this.extractExpMs(accessToken);
    const refreshTokenExpiresAt = this.extractExpMs(refreshToken);
    const refreshTokenWarnAt =
      refreshTokenExpiresAt !== null
        ? refreshTokenExpiresAt - 15 * 60 * 1000
        : null;

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      refreshTokenWarnAt,
    };
  }

  private extractExpMs(token: string): number | null {
    const decoded = this.jwtService.decode(token) as { exp?: number } | null;
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
