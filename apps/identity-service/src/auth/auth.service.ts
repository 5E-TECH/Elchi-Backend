import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { StringValue } from 'ms';
import { UserAdminEntity } from '../entities/user.entity';
import { BcryptEncryption } from '../../../../libs/common/helpers/bcrypt';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Status } from '@app/common';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserAdminEntity)
    private readonly users: Repository<UserAdminEntity>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly bcryptEncryption: BcryptEncryption,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.users.findOne({
      where: { phone_number: dto.phone_number, is_deleted: false, status: Status.ACTIVE },
    });
    if (!user) {
      throw new RpcException({ statusCode: 401, message: 'Invalid credentials' });
    }

    const isMatch = await this.bcryptEncryption.compare(dto.password, user.password);
    if (!isMatch) {
      throw new RpcException({ statusCode: 401, message: 'Invalid credentials' });
    }

    const tokens = await this.issueTokens(user);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
    return {
      user: this.sanitize(user),
      ...tokens,
    };
  }

  async validateUser(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId, is_deleted: false, status: Status.ACTIVE },
    });
    if (!user) {
      throw new RpcException({ statusCode: 401, message: 'User not found' });
    }

    return this.sanitize(user);
  }

  async refresh(dto: RefreshDto) {
    const refreshSecret = this.configService.get<string>('REFRESH_TOKEN_KEY');
    if (!refreshSecret) {
      throw new RpcException({ statusCode: 401, message: 'Refresh secret not configured' });
    }

    let payload: { sub: string; username: string };
    try {
      payload = await this.jwtService.verifyAsync<{ sub: string; username: string }>(
        dto.refreshToken,
        { secret: refreshSecret },
      );
    } catch {
      throw new RpcException({ statusCode: 401, message: 'Invalid refresh token' });
    }

    const user = await this.users.findOne({
      where: { id: payload.sub, is_deleted: false, status: Status.ACTIVE },
    });
    if (!user || user.username !== payload.username) {
      throw new RpcException({ statusCode: 401, message: 'Invalid refresh token' });
    }

    if (!user.refresh_token || user.refresh_token !== dto.refreshToken) {
      throw new RpcException({ statusCode: 401, message: 'Invalid refresh token' });
    }

    const tokens = await this.issueTokens(user);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
    return {
      user: this.sanitize(user),
      ...tokens,
    };
  }

  async logout(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId, is_deleted: false, status: Status.ACTIVE },
    });

    if (!user) {
      throw new RpcException({ statusCode: 401, message: 'User not found' });
    }

    user.refresh_token = null;
    await this.users.save(user);

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  private async saveRefreshToken(userId: string, refreshToken: string) {
    await this.users.update({ id: userId }, { refresh_token: refreshToken });
  }

  private async issueTokens(user: UserAdminEntity) {
    const payload: Record<string, unknown> = {
      sub: user.id,
      username: user.username,
      roles: [user.role],
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('REFRESH_TOKEN_KEY'),
      expiresIn: (this.configService.get<string>('REFRESH_TOKEN_TIME') ??
        '7d') as StringValue,
    });

    return { accessToken, refreshToken };
  }

  private sanitize(user: UserAdminEntity) {
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
