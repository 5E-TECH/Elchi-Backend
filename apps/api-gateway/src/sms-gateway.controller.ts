import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  ApproveSmsTemplateDto,
  GrantSmsConsentDto,
  RevokeSmsConsentDto,
  SmsCampaignDto,
  SmsReportQueryDto,
  UpsertSmsAccountDto,
  UpsertSmsTemplateDto,
} from './dto/sms.swagger.dto';

interface AuthedRequest {
  user?: { sub?: string; roles?: string[] };
}

const sendVia = async <T = unknown>(
  client: ClientProxy,
  pattern: object,
  payload: object,
  timeoutMs = 15_000,
): Promise<T> =>
  firstValueFrom(
    client.send<T>(pattern, payload).pipe(timeout(timeoutMs)),
  ).catch((error: unknown) => {
    if (error instanceof TimeoutError) {
      throw new GatewayTimeoutException(
        'Notification service response timeout',
      );
    }
    throw error;
  });

/**
 * SMS boshqaruvi (admin): holat, tariflar, xarajat hisoboti, provayder
 * akkauntlari, shablonlar, kampaniya va rozilik.
 */
@ApiTags('SMS')
@ApiBearerAuth()
@Controller('notifications/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
export class SmsGatewayController {
  constructor(@Inject('NOTIFICATION') private readonly client: ClientProxy) {}

  private send<T = unknown>(
    cmd: string,
    payload: object = {},
    timeoutMs?: number,
  ) {
    return sendVia<T>(this.client, { cmd }, payload, timeoutMs);
  }

  @Get('status')
  @ApiOperation({
    summary:
      'SMS holati: yoqilganmi, akkauntlar, bugungi sarf, kvota, tariflar',
  })
  status() {
    return this.send('notification.sms.status');
  }

  @Get('tariffs')
  @ApiOperation({ summary: "Bir bo'lak narxi (so'm). Sozlanmagan bo'lsa null" })
  tariffs() {
    return this.send('notification.sms.tariffs');
  }

  @Get('report')
  @ApiOperation({
    summary: "Xarajat hisoboti: Toshkent kuni × sinf (soni, yetkazilgan, so'm)",
  })
  report(@Query() query: SmsReportQueryDto) {
    return this.send('notification.sms.report', { ...query });
  }

  @Get('accounts')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'Provayder akkauntlari (login maskalangan, parol qaytmaydi)',
  })
  accounts() {
    return this.send('notification.sms.accounts.list');
  }

  @Put('accounts')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'Provayder akkaunti — kredensial DB da shifrlanadi',
  })
  @ApiBody({ type: UpsertSmsAccountDto })
  upsertAccount(@Body() dto: UpsertSmsAccountDto, @Req() req: AuthedRequest) {
    return this.send('notification.sms.accounts.upsert', {
      ...dto,
      requester_id: req.user?.sub ?? null,
    });
  }

  @Get('templates')
  @ApiOperation({
    summary: "Shablonlar (kodlash, bo'laklar, tasdiq holati bilan)",
  })
  templates() {
    return this.send('notification.sms.templates.list');
  }

  @Post('templates')
  @ApiOperation({
    summary:
      "Shablon yaratish/yangilash (matn o'zgarsa provayder tasdig'i bekor)",
  })
  @ApiBody({ type: UpsertSmsTemplateDto })
  upsertTemplate(@Body() dto: UpsertSmsTemplateDto) {
    return this.send('notification.sms.templates.upsert', { ...dto });
  }

  @Patch('templates/:id/approve')
  @ApiOperation({ summary: 'Provayder tasdiqlagan shablon id sini yozish' })
  @ApiBody({ type: ApproveSmsTemplateDto })
  approveTemplate(@Param('id') id: string, @Body() dto: ApproveSmsTemplateDto) {
    return this.send('notification.sms.templates.approve', { id, ...dto });
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: "Shablonni o'chirish" })
  deleteTemplate(@Param('id') id: string) {
    return this.send('notification.sms.templates.delete', { id });
  }

  @Post('campaigns/preview')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Tasdiq oynasi: aniq qabul qiluvchilar, roziligi yo'qlar, prognoz narx (hech narsa yuborilmaydi)",
  })
  @ApiBody({ type: SmsCampaignDto })
  previewCampaign(@Body() dto: SmsCampaignDto) {
    return this.send('notification.sms.campaign.preview', { ...dto }, 30_000);
  }

  @Post('campaigns')
  @ApiOperation({
    summary: 'Kampaniyani yuborish (Idempotency-Key majburiy — takror 409)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: SmsCampaignDto })
  sendCampaign(
    @Body() dto: SmsCampaignDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.send(
      'notification.sms.campaign.send',
      {
        ...dto,
        idempotency_key: idempotencyKey ?? null,
        requester_id: req.user?.sub ?? null,
      },
      30_000,
    );
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'Kampaniyalar tarixi: sent/failed/blocked' })
  campaigns(@Query('limit') limit?: string) {
    return this.send('notification.sms.campaign.history', {
      limit: Number(limit) || 50,
    });
  }

  @Post('consents')
  @ApiOperation({ summary: 'Reklama roziligini qayd etish (operator)' })
  @ApiBody({ type: GrantSmsConsentDto })
  grantConsent(@Body() dto: GrantSmsConsentDto, @Req() req: AuthedRequest) {
    return this.send('notification.sms.consent.grant', {
      ...dto,
      evidence: { ...(dto.evidence ?? {}), operator_id: req.user?.sub ?? null },
    });
  }

  @Post('consents/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: "Raqam bo'yicha reklama roziligini bekor qilish" })
  @ApiBody({ type: RevokeSmsConsentDto })
  revokeConsent(@Body() dto: RevokeSmsConsentDto) {
    return this.send('notification.sms.consent.revoke', { ...dto });
  }
}

/**
 * Public SMS yo'llari: provayder DLR webhook'i va reklama SMS'dagi bekor qilish
 * havolasi. JWT yo'q — tekshiruv notification-service'da (sir o'sha yerda).
 */
@ApiTags('SMS')
@Controller()
export class SmsPublicGatewayController {
  constructor(@Inject('NOTIFICATION') private readonly client: ClientProxy) {}

  @Public()
  @Post('webhooks/sms/:provider')
  @HttpCode(200)
  @ApiOperation({
    summary: 'SMS yetkazilganlik hisoboti (DLR) — har xabar HMAC token bilan',
  })
  deliveryReport(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    return sendVia(
      this.client,
      { cmd: 'notification.sms.dlr' },
      {
        provider: String(provider ?? '').toLowerCase(),
        query: query ?? {},
        body: body ?? {},
      },
    );
  }

  @Public()
  @Get('sms/stop/:token')
  @ApiOperation({ summary: 'Reklama SMS dan chiqish (opt-out) havolasi' })
  async optOut(@Param('token') token: string, @Res() res: Response) {
    let ok = true;
    try {
      await sendVia(
        this.client,
        { cmd: 'notification.sms.opt_out' },
        { token },
      );
    } catch {
      ok = false;
    }
    res
      .status(ok ? 200 : 404)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Elchi</title>` +
          `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center">` +
          (ok
            ? `<h2>Obuna bekor qilindi</h2><p>Siz Elchi reklama SMS'laridan chiqdingiz. Buyurtma holati haqidagi xabarlar kelaveradi.</p>`
            : `<h2>Havola noto'g'ri</h2><p>Havola eskirgan yoki buzilgan.</p>`) +
          `</body>`,
      );
  }
}
