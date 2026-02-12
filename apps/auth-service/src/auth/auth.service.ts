import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import * as bcrypt from 'bcryptjs';
import type { StringValue } from 'ms';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Roles } from '@app/common';

@Injectable()
export class AuthService {
  constructor(
    @Inject('USER') private readonly userClient: ClientProxy,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.getUserByUsername(dto.username);
    if (existing) {
      throw new ConflictException('Username already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.createUser(dto.username, passwordHash);

    const tokens = await this.issueTokens(user);
    return {
      user: this.sanitize(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.getUserByUsername(dto.username);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokens(user);
    return {
      user: this.sanitize(user),
      ...tokens,
    };
  }

  async validateUser(userId: string) {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitize(user);
  }

  async refresh(dto: RefreshDto) {
    const refreshSecret = this.configService.get<string>('REFRESH_TOKEN_KEY');
    if (!refreshSecret) {
      throw new UnauthorizedException('Refresh secret not configured');
    }

    let payload: { sub: string; username: string };
    try {
      payload = await this.jwtService.verifyAsync<{ sub: string; username: string }>(
        dto.refreshToken,
        { secret: refreshSecret },
      );
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.getUserById(payload.sub);
    if (!user || user.username !== payload.username) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.issueTokens(user);
    return {
      user: this.sanitize(user),
      ...tokens,
    };
  }

  private async issueTokens(user: UserRecord) {
    const payload: Record<string, unknown> = {
      sub: user.id,
      username: user.username,
      roles: [Roles.CUSTOMER],
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('REFRESH_TOKEN_KEY'),
      expiresIn: (this.configService.get<string>('REFRESH_TOKEN_TIME') ??
        '7d') as StringValue,
    });

    return { accessToken, refreshToken };
  }

  private sanitize(user: UserRecord) {
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private async getUserByUsername(username: string): Promise<UserRecord | null> {
    return lastValueFrom(
      this.userClient.send({ cmd: 'get_user_by_username' }, { username }),
    );
  }

  private async getUserById(id: string): Promise<UserRecord | null> {
    return lastValueFrom(this.userClient.send({ cmd: 'get_user_by_id' }, { id }));
  }

  private async createUser(username: string, password: string): Promise<UserRecord> {
    return lastValueFrom(
      this.userClient.send({ cmd: 'create_user' }, { username, password }),
    );
  }
}

interface UserRecord {
  id: string;
  username: string;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}
