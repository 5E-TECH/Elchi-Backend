import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { TelegramLinkCodeRequestDto } from './dto/notification.swagger.dto';

interface AuthedRequest {
  user?: { sub?: string; roles?: string[] };
  ip?: string;
}

/**
 * Telegram bog'lash — PANELDAN boshlanadi (6jXw0DDr / 4TfLyTrL / 9uNhwTZp /
 * td89SKXQ). Kim va kimga — faqat JWT'dan (so'rov tanasidan user_id yoki
 * chat_id OLINMAYDI). Bir martalik kod 10 daqiqa, faqat hash saqlanadi.
 */
@ApiTags('Telegram')
@Controller()
export class TelegramGatewayController {
  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private async send<T = unknown>(
    client: ClientProxy,
    pattern: object,
    payload: object,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Service response timeout');
      }
      throw error;
    });
  }

  private requester(req: AuthedRequest) {
    const id = req.user?.sub;
    if (!id) throw new UnauthorizedException('User not authenticated');
    return { id: String(id), roles: req.user?.roles ?? [] };
  }

  @Post('telegram/link-code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiBody({ type: TelegramLinkCodeRequestDto })
  @ApiOperation({
    summary:
      "Bir martalik Telegram bog'lash kodi: `user` — o'z akkaunti (t.me/<bot>?start=…), `market_group` — market guruhi (t.me/<bot>?startgroup=…). Javob: { token, purpose, expires_at, deep_link, command } (10 daqiqa). Mijoz/investor — 403.",
  })
  linkCode(@Body() dto: TelegramLinkCodeRequestDto, @Req() req: AuthedRequest) {
    return this.send(
      this.notificationClient,
      { cmd: 'notification.telegram.link_code' },
      {
        purpose: dto.purpose ?? 'user',
        market_id: dto.market_id,
        group_type: dto.group_type,
        requester: this.requester(req),
        ip: req.ip ?? null,
      },
    );
  }

  @Post('users/me/telegram/link-code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "O'z akkauntini Telegram'ga ulash havolasi (bir martalik, 10 daqiqa): { token, deep_link, command, expires_at }. QR — deep_link dan.",
  })
  myLinkCode(@Req() req: AuthedRequest) {
    return this.send(
      this.notificationClient,
      { cmd: 'notification.telegram.link_code' },
      { purpose: 'user', requester: this.requester(req), ip: req.ip ?? null },
    );
  }

  @Delete('users/me/telegram')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "O'z akkauntini Telegram'dan uzish: telegram_id null, audit yoziladi. { unlinked: boolean }",
  })
  unlinkMe(@Req() req: AuthedRequest) {
    return this.send(
      this.identityClient,
      { cmd: 'identity.telegram.unlink' },
      { user_id: this.requester(req).id },
    );
  }

  @Get('telegram/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Rol bo'yicha Telegram'ga ulanganlar: [{ role, total, linked, ratio }] (faol xodimlar). 0 — bog'lash oqimi buzilgan.",
  })
  stats() {
    return this.send(
      this.identityClient,
      { cmd: 'identity.telegram.stats' },
      {},
    );
  }
}
