import {
  Body,
  Controller,
  Get,
  Inject,
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
import type { Request, Response } from 'express';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  LoginRequestDto,
  RefreshRequestDto,
} from './dto/auth.swagger.dto';

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
    const now = Date.now();
    const maxAge = Math.max(
      1,
      (expiresAtMs ?? now + AuthGatewayController.FALLBACK_REFRESH_TTL_MS) - now,
    );

    res.cookie(AuthGatewayController.REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth',
      maxAge,
    });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(AuthGatewayController.REFRESH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth',
    });
  }

  private sanitizeAuthPayload(payload: Record<string, unknown>) {
    const { refreshToken, ...rest } = payload;
    return rest;
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with phone number and password' })
  @ApiBody({ type: LoginRequestDto })
  @ApiCreatedResponse({ description: 'Login successful' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  async login(
    @Body() dto: { phone_number: string; password: string },
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

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshRequestDto })
  @ApiCreatedResponse({ description: 'Token refreshed' })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token' })
  async refresh(
    @Req() req: Request,
    @Body() dto: { refreshToken?: string },
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
}
