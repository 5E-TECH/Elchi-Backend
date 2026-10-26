import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { refreshCookieOptions } from './auth/refresh-cookie';
import {
  SessionKickReason,
  SessionRevocationService,
  applyRevokedSessionIds,
} from './auth/session-revocation.service';
import { TelegramIdThrottlerGuard } from './auth/telegram-id-throttler.guard';
import { TelegramAuthRequestDto } from './dto/notification.swagger.dto';

// Decorator metadata evaluates at class load — read env directly (the
// ConfigModule/Joi defaults are applied later, so they do not reach here).
/** Musbat butun son; bo'sh yoki noto'g'ri qiymatda — sukut. */
const positiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

/**
 * Auth endpointlari rate limiti (fix3 C10, RBAC-11), har ikkisi per IP
 * (`ClientIpThrottlerGuard` — CF-Connecting-IP) va har route o'z hisoblagichi:
 *
 *  - LOGIN — sukut 30/daqiqa (`AUTH_THROTTLE_LIMIT`/`AUTH_THROTTLE_TTL_MS`).
 *    Ilgari 10 edi: ofis Wi-Fi yoki operator NAT ortidagi 10+ xodim smena
 *    boshida bir vaqtda kirsa 429 olardi.
 *  - REFRESH — sukut 60/daqiqa, login'dan ALOHIDA o'zgaruvchi
 *    (`AUTH_REFRESH_THROTTLE_LIMIT`/`AUTH_REFRESH_THROTTLE_TTL_MS`). Refresh
 *    parol tekshirmaydi (brute-force nishoni emas), lekin smena boshida har
 *    tab tokenini yangilaydi — 10/min da 429 foydalanuvchini chiqarib
 *    yuborardi. Prod `.env` dagi eski `AUTH_THROTTLE_LIMIT=10` refresh'ga
 *    endi ta'sir qilmaydi.
 */
export function authThrottleConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    login: {
      default: {
        limit: positiveIntEnv(env.AUTH_THROTTLE_LIMIT, 30),
        ttl: positiveIntEnv(env.AUTH_THROTTLE_TTL_MS, 60_000),
      },
    },
    refresh: {
      default: {
        limit: positiveIntEnv(env.AUTH_REFRESH_THROTTLE_LIMIT, 60),
        ttl: positiveIntEnv(env.AUTH_REFRESH_THROTTLE_TTL_MS, 60_000),
      },
    },
  };
}

const AUTH_THROTTLES = authThrottleConfig();
export const AUTH_THROTTLE = AUTH_THROTTLES.login;
export const AUTH_REFRESH_THROTTLE = AUTH_THROTTLES.refresh;
import {
  AuthSessionTooNewErrorResponseDto,
  AuthSessionsErrorResponseDto,
  AuthSessionsResponseDto,
  AuthSessionsRevokeResponseDto,
  LoginRequestDto,
  MinimalAuthResponseDto,
  RefreshRequestDto,
} from './dto/auth.swagger.dto';
import { UpdateAdminRequestDto } from './dto/identity.swagger.dto';
import { OtpRequestDto, OtpVerifyDto } from './dto/sms.swagger.dto';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
  /**
   * (Elchi Pochta #3) Sessiya id si (`identity_schema.user_sessions.id`) —
   * login/refresh access tokenlarida. Telegram tokenlarida va deploy'dan
   * oldingi tokenlarda yo'q.
   */
  sid?: string | null;
}

/** identity javobidagi yopilgan sessiya id lari (logout / revoke). */
type RevokedSessionsReply = { data?: { session_ids?: unknown } } | null;

@ApiTags('Auth')
@Controller('auth')
export class AuthGatewayController {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly revocation: SessionRevocationService,
  ) {}

  private static currentSid(user: JwtUser): string | null {
    return typeof user.sid === 'string' ? user.sid : null;
  }

  /**
   * (Elchi Pochta #3) identity tasdiqlagan yopilgan sessiyalar shu gateway
   * keshida darhol «yopilgan» — ularning access tokeni keyingi so'rovdayoq 401.
   * (2026-10-24) Ochiq socketlari ham shu zahoti `auth:session_revoked`
   * (`reason`) oladi va uziladi — qurilma keyingi so'rovini kutmaydi.
   */
  private kickRevoked(
    response: RevokedSessionsReply,
    reason: SessionKickReason,
  ): void {
    const ids = response?.data?.session_ids;
    if (Array.isArray(ids)) this.revocation.kickSessions(ids, reason);
  }

  private static readonly REFRESH_COOKIE_NAME = 'refreshToken';
  // identity `REFRESH_TOKEN_TIME` sukuti (1d) bilan bir xil — faqat javobda
  // muddat bo'lmasa ishlatiladi.
  private static readonly FALLBACK_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Send to identity-service with a hard timeout. Without it, login/refresh and
   * the other auth calls hang indefinitely when identity is down or a reply is
   * lost, holding the socket until Cloudflare 524s it. (Audit P1-6.)
   */
  private sendIdentity<T = unknown>(
    pattern: { cmd: string },
    payload: object,
  ): Promise<T> {
    return firstValueFrom(
      this.identityClient.send<T>(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

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
      (expiresAtMs ?? now + AuthGatewayController.FALLBACK_REFRESH_TTL_MS) -
        now,
    );

    // (NDmZMzCP) SameSite sukut `Lax` (ilgari prod'da `None`) — refresh-cookie.ts.
    res.cookie(AuthGatewayController.REFRESH_COOKIE_NAME, refreshToken, {
      ...refreshCookieOptions(),
      maxAge,
    });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(
      AuthGatewayController.REFRESH_COOKIE_NAME,
      refreshCookieOptions(),
    );
  }

  private sanitizeAuthPayload(payload: Record<string, unknown>) {
    const accessToken =
      typeof payload.accessToken === 'string' ? payload.accessToken : null;

    if (!accessToken) {
      throw new UnauthorizedException('Access token not found');
    }

    const accessTokenExpiresAt =
      typeof payload.accessTokenExpiresAt === 'number'
        ? payload.accessTokenExpiresAt
        : typeof payload.access_token_expires_at === 'number'
          ? payload.access_token_expires_at
          : null;
    const refreshTokenExpiresAt =
      typeof payload.refreshTokenExpiresAt === 'number'
        ? payload.refreshTokenExpiresAt
        : typeof payload.refresh_token_expires_at === 'number'
          ? payload.refresh_token_expires_at
          : null;
    const refreshTokenWarnAt =
      typeof payload.refreshTokenWarnAt === 'number'
        ? payload.refreshTokenWarnAt
        : typeof payload.refresh_token_warn_at === 'number'
          ? payload.refresh_token_warn_at
          : null;

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      refreshTokenWarnAt,
      access_token_expires_at: accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
      refresh_token_warn_at: refreshTokenWarnAt,
    };
  }

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };
  }

  @Throttle(AUTH_THROTTLE)
  @Public()
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
    const response = await this.sendIdentity<Record<string, unknown>>(
      { cmd: 'identity.login' },
      dto,
    );

    const refreshToken =
      typeof response.refreshToken === 'string' ? response.refreshToken : null;

    if (refreshToken) {
      this.setRefreshCookie(
        res,
        refreshToken,
        this.getRefreshExpiryMs(response),
      );
    }

    return this.sanitizeAuthPayload(response);
  }

  /**
   * (xC88d8kH #2) Telegram Mini App kirishi: `init_data` (WebApp.initData)
   * identity'da bot tokeni bilan HMAC tekshiriladi (auth_date ≤ 5 daqiqa),
   * `users.telegram_id` bo'yicha xodim topiladi → 30 daqiqalik access JWT.
   * Refresh BERILMAYDI (cookie ham qo'yilmaydi). Bog'lanmagan → 401
   * "avval kabinetdan ulang". Limit: IP (AUTH_THROTTLE) + Telegram id 5/daqiqa.
   */
  @Throttle(AUTH_THROTTLE)
  @UseGuards(TelegramIdThrottlerGuard)
  @Public()
  @Post('telegram')
  @ApiOperation({
    summary:
      'Telegram Mini App login: initData → short-lived access token (30 min), no refresh token',
  })
  @ApiBody({ type: TelegramAuthRequestDto })
  @ApiUnauthorizedResponse({
    description:
      "initData imzosi noto'g'ri / eskirgan yoki akkaunt bog'lanmagan",
  })
  telegramLogin(@Body() dto: TelegramAuthRequestDto) {
    // identity refresh token BERMAYDI — javob shundayligicha.
    return this.sendIdentity<Record<string, unknown>>(
      { cmd: 'identity.auth.telegram' },
      { init_data: dto.init_data },
    );
  }

  /**
   * OTP so'rash (rkz0yBxr). Javob raqam ro'yxatdan o'tgan-o'tmaganidan qat'i
   * nazar BIR XIL. Limitlar: IP — ClientIpThrottlerGuard + AUTH_THROTTLE;
   * raqam — identity-service (60 s / soat / kun).
   */
  @Throttle(AUTH_THROTTLE)
  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Request a one-time SMS code (same answer whether the number exists or not)',
  })
  @ApiBody({ type: OtpRequestDto })
  otpRequest(@Body() dto: OtpRequestDto, @Req() req: Request) {
    return this.sendIdentity<Record<string, unknown>>(
      { cmd: 'identity.otp.request' },
      { ...dto, ip: this.clientIp(req) },
    );
  }

  @Throttle(AUTH_THROTTLE)
  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verify the SMS code; for purpose=login returns tokens like /auth/login (customers only)',
  })
  @ApiBody({ type: OtpVerifyDto })
  async otpVerify(
    @Body() dto: OtpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await this.sendIdentity<Record<string, unknown>>(
      { cmd: 'identity.otp.verify' },
      { ...dto, ip: this.clientIp(req) },
    );
    const refreshToken =
      typeof response.refreshToken === 'string' ? response.refreshToken : null;
    if (refreshToken) {
      this.setRefreshCookie(
        res,
        refreshToken,
        this.getRefreshExpiryMs(response),
      );
      return this.sanitizeAuthPayload(response);
    }
    return response;
  }

  /** Haqiqiy mijoz IP'si (Cloudflare ortida) — faqat audit uchun. */
  private clientIp(req: Request): string | null {
    const raw = req.headers['cf-connecting-ip'];
    const cf = Array.isArray(raw) ? raw[0] : raw;
    return (cf || req.ip || null)?.toString().slice(0, 64) ?? null;
  }

  @Throttle(AUTH_REFRESH_THROTTLE)
  @Public()
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

    const response = await this.sendIdentity<Record<string, unknown>>(
      { cmd: 'identity.refresh' },
      { refreshToken },
    );

    const nextRefreshToken =
      typeof response.refreshToken === 'string' ? response.refreshToken : null;

    if (nextRefreshToken) {
      this.setRefreshCookie(
        res,
        nextRefreshToken,
        this.getRefreshExpiryMs(response),
      );
    }

    return this.sanitizeAuthPayload(response);
  }

  /**
   * (Elchi Pochta #3) Faqat JORIY sessiya yopiladi — shu akkauntning boshqa
   * qurilmalari ishlashda davom etadi. Sessiya access token `sid` i va shu
   * brauzerning refresh cookie'si bo'yicha aniqlanadi (cookie `path=/auth`,
   * shuning uchun bu so'rovga ham keladi).
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout the current session only (other devices stay signed in)',
  })
  @ApiOkResponse({ description: 'Logged out' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async logout(
    @Req() req: Request & { user: JwtUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const response = await this.sendIdentity<RevokedSessionsReply>(
      { cmd: 'identity.logout' },
      {
        userId: req.user.sub,
        sessionId: AuthGatewayController.currentSid(req.user),
        refreshToken: this.readCookie(
          req,
          AuthGatewayController.REFRESH_COOKIE_NAME,
        ),
      },
    );
    // Joriy sessiya — shu brauzerning boshqa tablari ham chiqadi.
    this.kickRevoked(response, 'logout');
    this.clearRefreshCookie(res);
    return response;
  }

  /**
   * (Elchi Pochta #3) "Sessionlar" bo'limi — akkaunt egasi O'Z akkauntiga
   * kirgan qurilmalarni ko'radi (bitta qurilma — bitta sessiya): faollar
   * soni, qurilma, IP, birinchi / oxirgi login, oxirgi faollik, holat
   * (`active` / `expired` — «Qayta kirish kerak»), joriy sessiya belgisi.
   * Har qanday autentifikatsiyadan o'tgan rol (`@Roles` yo'q); kim — faqat
   * JWT `sub` dan, so'rovda boshqa foydalanuvchi id si qabul qilinmaydi.
   * Tizim bo'yicha umumiy ro'yxat yo'q.
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Own sessions (one per device) of the current account: active count, device, IP, first/last login, last-seen, status, current flag',
    description:
      "Ochiq sessiyalar: `status: 'active'` (ishlayapti) yoki `'expired'` (refresh muddati o'tgan / parol almashgan — «Qayta kirish kerak»; shu qurilmadan login AYNI sessiyani tiklaydi). Tartib: joriy → active → expired (oxirgi faollik bo'yicha). `active_count` — faqat active lar. Muddati 90 kundan ko'p oldin o'tgan sessiyalar o'chiriladi. (2026-10-23) `can_revoke_others` / `revoke_available_at` — joriy sessiya boshqalarni yopa oladimi va qachondan (48 soatlik qulf).",
  })
  @ApiOkResponse({ type: AuthSessionsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  mySessions(@Req() req: { user: JwtUser }) {
    return this.sendIdentity(
      { cmd: 'identity.auth.sessions' },
      {
        userId: req.user.sub,
        sessionId: AuthGatewayController.currentSid(req.user),
      },
    );
  }

  /**
   * (Elchi Pochta #3) «Boshqa sessiyalardan chiqish» — joriy sessiyadan
   * (JWT `sid`) boshqa BARCHA sessiyalar yopiladi; joriy qurilma ishlashda
   * davom etadi. Har qanday autentifikatsiyadan o'tgan rol, kim — faqat JWT
   * `sub`. Yopilgan qurilmalarning access tokeni darhol 401 (shu gateway
   * keshi), refresh ham 401 — ular login sahifasiga chiqadi. (2026-10-23)
   * 48 soatdan yosh sessiya → 403 SESSION_TOO_NEW (identity qaror qiladi).
   */
  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Log out all OTHER sessions of the current account (the current one stays)',
    description:
      "Javob: `data = { revoked, session_ids }` (0 ham bo'lishi mumkin). `sid` siz token (Telegram / eski) → 400 «Joriy sessiya aniqlanmadi — qayta kiring». (2026-10-23) Joriy sessiya shu qurilmadan birinchi kirilganiga 48 soat to'lmagan → 403 `code: 'SESSION_TOO_NEW'` + `available_at` (hech narsa yopilmaydi).",
  })
  @ApiOkResponse({ type: AuthSessionsRevokeResponseDto })
  @ApiBadRequestResponse({
    description: 'Joriy sessiya aniqlanmadi — qayta kiring',
    type: AuthSessionsErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'SESSION_TOO_NEW — joriy sessiya 48 soatdan yosh, boshqa sessiyalarni yopa olmaydi',
    type: AuthSessionTooNewErrorResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized / Session revoked' })
  async revokeOtherSessions(@Req() req: { user: JwtUser }) {
    const response = await this.sendIdentity<RevokedSessionsReply>(
      { cmd: 'identity.auth.sessions.revoke_others' },
      {
        userId: req.user.sub,
        currentSessionId: AuthGatewayController.currentSid(req.user),
      },
    );
    this.kickRevoked(response, 'revoked_by_owner');
    return response;
  }

  /**
   * (Elchi Pochta #3) «Sessiyalar» ro'yxatidagi BOSHQA qurilma sessiyasini
   * yopish. Faqat o'z sessiyasi (identity `user_id` sharti bilan); begona,
   * yo'q yoki allaqachon yopilgan → 404. Joriy sessiya → 400 (uning uchun
   * `POST /auth/logout`, u cookie'ni ham tozalaydi).
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({
    name: 'id',
    description: '`GET /auth/sessions` dagi sessiya `id` si (UUID)',
    example: '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d',
  })
  @ApiOperation({
    summary: 'Log out one of my other sessions (another device)',
    description:
      "Javob: `data = { revoked: 1, session_ids: [id] }`. 400 — id UUID emas («Sessiya identifikatori noto'g'ri»), joriy sessiya («Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan foydalaning») yoki `sid` siz token («Joriy sessiya aniqlanmadi — qayta kiring»); 403 `SESSION_TOO_NEW` — joriy sessiya 48 soatdan yosh (nishon eski yoki yangi bo'lishidan qat'i nazar; `available_at` — qachondan mumkin); 404 — «Sessiya topilmadi yoki allaqachon yopilgan».",
  })
  @ApiOkResponse({ type: AuthSessionsRevokeResponseDto })
  @ApiBadRequestResponse({
    description: "Noto'g'ri id, joriy sessiya yoki `sid` siz token",
    type: AuthSessionsErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'SESSION_TOO_NEW — joriy sessiya 48 soatdan yosh, boshqa sessiyalarni yopa olmaydi',
    type: AuthSessionTooNewErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Sessiya topilmadi yoki allaqachon yopilgan',
    type: AuthSessionsErrorResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized / Session revoked' })
  async revokeSession(
    @Req() req: { user: JwtUser },
    @Param('id') sessionId: string,
  ) {
    const response = await this.sendIdentity<RevokedSessionsReply>(
      { cmd: 'identity.auth.sessions.revoke' },
      {
        userId: req.user.sub,
        sessionId,
        currentSessionId: AuthGatewayController.currentSid(req.user),
      },
    );
    this.kickRevoked(response, 'revoked_by_owner');
    return response;
  }

  @Get('validate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate current JWT token' })
  @ApiOkResponse({ description: 'Token valid' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  validate(@Req() req: { user: JwtUser }) {
    return this.sendIdentity(
      { cmd: 'identity.validate' },
      { userId: req.user.sub },
    );
  }

  @Get('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({
    description:
      'Current user profile. x6IO746K (N13): market operatorida ' +
      '`market: { id, name, add_order } | null` (market o`chirilgan / ' +
      'topilmagan — null; boshqa rollarda kalit yo`q).',
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  myProfile(@Req() req: { user: JwtUser }) {
    return this.sendIdentity(
      { cmd: 'identity.user.profile' },
      { id: req.user.sub },
    );
  }

  /**
   * (Elchi Pochta #3, 2026-10-23) `password` bilan: boshqa barcha
   * sessiyalar DARHOL yopiladi (48 soatlik qulfga bog'liq emas), JORIY
   * sessiya (JWT `sid`) ishlashda davom etadi — refresh ham. Yopilganlar shu
   * gateway keshida darhol «yopilgan» va (2026-10-24) socketlari
   * `auth:session_revoked` (`password_changed`) olib uziladi; javobda
   * `sessions_revoked` (soni).
   */
  @Patch('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update current user profile',
    description:
      "`password` berilsa: joriy sessiyadan BOSHQA barcha sessiyalar darhol yopiladi (`password_changed`; 48 soatlik qulfga bog'liq emas), joriy sessiya va uning refresh'i ishlashda davom etadi. Javobga `sessions_revoked: <n>` qo'shiladi. `sid` siz token (Telegram) — barcha sessiyalar yopiladi.",
  })
  @ApiBody({ type: UpdateAdminRequestDto })
  @ApiOkResponse({ description: 'Current user profile updated' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async updateMyProfile(
    @Req() req: { user: JwtUser },
    @Body() dto: UpdateAdminRequestDto,
  ) {
    const response = await this.sendIdentity(
      { cmd: 'identity.user.update' },
      {
        id: req.user.sub,
        dto,
        requester: this.toRequester(req),
        current_session_id: AuthGatewayController.currentSid(req.user),
      },
    );
    return applyRevokedSessionIds(response, this.revocation);
  }

  @Patch('my-settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user UI settings/preferences' })
  @ApiOkResponse({ description: 'Settings updated' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  updateMySettings(
    @Req() req: { user: JwtUser },
    @Body() body: { settings: Record<string, unknown> | null },
  ) {
    return this.sendIdentity(
      { cmd: 'identity.me.update_settings' },
      { id: req.user.sub, settings: body?.settings ?? null },
    );
  }
}
