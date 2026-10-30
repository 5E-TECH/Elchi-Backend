import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum, TELEGRAM_DM_DELIVERY_PATTERN } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AllowTelegramScanScope } from './auth/telegram-scan-scope.guard';
import {
  TelegramLinkCodeRequestDto,
  TelegramScanDoneRequestDto,
} from './dto/notification.swagger.dto';
import {
  TelegramDmDeliveryQueryDto,
  TelegramDmDeliveryResponseDto,
} from './dto/telegram-dm-delivery.swagger.dto';

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
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }

  private requester(req: AuthedRequest) {
    const id = req.user?.sub;
    if (!id)
      throw new UnauthorizedException(
        "Foydalanuvchi autentifikatsiyadan o'tmagan",
      );
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

  /**
   * (MWYaqprw #6) Skan Mini App'ida "✅ Tayyor": kuryerning shaxsiy
   * Telegram'iga (va in-app) "N ta buyurtma qabul qilindi" + "📋 Topshiriqlarim".
   * Kuryer — faqat JWT'dan; son — server hisoblaydi (shu kuryerda yo'lda
   * turgan id'lar).
   */
  @Post('telegram/scan/done')
  // BOT-2: Telegram Mini App (`tg_scan`) tokeni bilan ochiq.
  @AllowTelegramScanScope()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiBody({ type: TelegramScanDoneRequestDto })
  @ApiOperation({
    summary:
      "Skan Mini App «✅ Tayyor»: botga xulosa xabari (faqat kuryer). Javob: { accepted, ignored } — accepted = yuborilgan id'lardan HOZIR shu kuryerda yo'lda turganlari.",
  })
  scanDone(@Body() dto: TelegramScanDoneRequestDto, @Req() req: AuthedRequest) {
    return this.send(
      this.notificationClient,
      { cmd: 'notification.telegram.scan_done' },
      { courier_id: this.requester(req).id, order_ids: dto.order_ids },
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

  /**
   * (2crjWf7v) «Yetkazish metrikasi: kvitansiya yuborilgan/yetgan nisbati
   * dashboardda» — backend qismi. Faqat superadmin, faqat o'qish. Ma'lumot
   * saqlangan `notifications.delivery.telegram` dan (Prometheus
   * `bot_dm_delivery_total` hisoblagichi xotirada, restart'da nolga tushadi).
   */
  @Get('telegram/dm-delivery')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOkResponse({ type: TelegramDmDeliveryResponseDto })
  @ApiOperation({
    summary:
      "Shaxsiy Telegram xabarlari (sukut: to'lov kvitansiyasi) yetkazish hisoboti davr bo'yicha: totals / by_role / days — total, sent, failed, pending, skipped, no_provider, other, delivery_ratio = sent/(sent+failed+pending), reach_ratio = sent/total (0..1, maxraj 0 → null); skipped_reasons. Faqat superadmin.",
  })
  dmDelivery(@Query() query: TelegramDmDeliveryQueryDto) {
    return this.send(
      this.notificationClient,
      { cmd: TELEGRAM_DM_DELIVERY_PATTERN },
      { from: query.from, to: query.to, type: query.type },
    );
  }
}
