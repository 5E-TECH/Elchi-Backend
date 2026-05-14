import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

// Decorator metadata evaluates at class load — read env directly so the values
// pick up the same .env defaults that gatewayValidationSchema declares.
const AUTH_THROTTLE_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT ?? '10');
const AUTH_THROTTLE_TTL_MS = Number(process.env.AUTH_THROTTLE_TTL_MS ?? '60000');
const AUTH_THROTTLE = {
  default: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS },
};
import {
  LoginRequestDto,
  MinimalAuthResponseDto,
  RefreshRequestDto,
} from './dto/auth.swagger.dto';
import { UpdateAdminRequestDto } from './dto/identity.swagger.dto';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
}

@ApiTags('Auth')
@Controller('auth')
export class AuthGatewayController {
  constructor(@Inject('IDENTITY') private readonly identityClient: ClientProxy) {}

  private static readonly REFRESH_COOKIE_NAME = 'refreshToken';
  private static readonly FALLBACK_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  private readCookie(req: Request, name: string): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return null;
    }

    const cookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));

    if (!cookie) {
      return null;
    }

    return decodeURIComponent(cookie.slice(name.length + 1));
  }

  private getRefreshExpiryMs(payload: Record<string, unknown>): number | null {
    const value =
      payload.refreshTokenExpiresAt ?? payload.refresh_token_expires_at;
    if (typeof value !== 'number') {
      return null;
    }
    return value;
  }

  private setRefreshCookie(
    res: Response,
    refreshToken: string,
    expiresAtMs: number | null,
  ) {
    const isProduction = process.env.NODE_ENV === 'production';
    const now = Date.now();
    const maxAge = Math.max(
      1,
      (expiresAtMs ?? now + AuthGatewayController.FALLBACK_REFRESH_TTL_MS) - now,
    );

    res.cookie(AuthGatewayController.REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/auth',
      maxAge,
    });
  }

  private clearRefreshCookie(res: Response) {
    const isProduction = process.env.NODE_ENV === 'production';
    res.clearCookie(AuthGatewayController.REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/auth',
    });
  }

  private sanitizeAuthPayload(payload: Record<string, unknown>) {
    const accessToken =
      typeof payload.accessToken === 'string' ? payload.accessToken : null;

    if (!accessToken) {
      throw new UnauthorizedException('Access token not found');
    }

    return { accessToken };
  }

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
  }

  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @ApiOperation({ summary: 'Login with phone number and password' })
  @ApiBody({ type: LoginRequestDto })
  @ApiCreatedResponse({
    description: 'Login successful',
    type: MinimalAuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  async login(
    @Body() dto: LoginRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = (await firstValueFrom(
      this.identityClient.send({ cmd: 'identity.login' }, dto),
    )) as Record<string, unknown>;

    const refreshToken =
      typeof response.refreshToken === 'string'
        ? response.refreshToken
        : null;

    if (refreshToken) {
      this.setRefreshCookie(res, refreshToken, this.getRefreshExpiryMs(response));
    }

    return this.sanitizeAuthPayload(response);
  }

  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshRequestDto })
  @ApiCreatedResponse({
    description: 'Token refreshed',
    type: MinimalAuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token' })
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshTokenFromCookie = this.readCookie(
      req,
      AuthGatewayController.REFRESH_COOKIE_NAME,
    );
    const refreshToken = refreshTokenFromCookie ?? dto?.refreshToken;

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token not found');
    }

    const response = (await firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.refresh' },
        { refreshToken },
      ),
    )) as Record<string, unknown>;

    const nextRefreshToken =
      typeof response.refreshToken === 'string'
        ? response.refreshToken
        : null;

    if (nextRefreshToken) {
      this.setRefreshCookie(res, nextRefreshToken, this.getRefreshExpiryMs(response));
    }

    return this.sanitizeAuthPayload(response);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  @ApiOkResponse({ description: 'Logged out' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async logout(
    @Req() req: { user: JwtUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await firstValueFrom(
      this.identityClient.send(
        { cmd: 'identity.logout' },
        { userId: req.user.sub },
      ),
    );
    this.clearRefreshCookie(res);
    return response;
  }

  @Get('validate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate current JWT token' })
  @ApiOkResponse({ description: 'Token valid' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  validate(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.validate' }, { userId: req.user.sub });
  }

  @Get('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({ description: 'Current user profile' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  myProfile(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.user.profile' }, { id: req.user.sub });
  }

  @Patch('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ description: 'Current user profile updated' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  updateMyProfile(
    @Req() req: { user: JwtUser },
    @Body() dto: UpdateAdminRequestDto,
  ) {
    return this.identityClient.send(
      { cmd: 'identity.user.update' },
      { id: req.user.sub, dto, requester: this.toRequester(req) },
    );
  }
}
