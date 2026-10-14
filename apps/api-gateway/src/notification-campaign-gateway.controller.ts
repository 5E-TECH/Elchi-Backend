import {
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AudiencePreviewRequestDto,
  CreateNotificationCampaignRequestDto,
  ListNotificationCampaignsQueryDto,
} from './dto/notification-campaign.swagger.dto';

interface AuthedRequest {
  user?: { sub?: string; roles?: string[] };
}

/**
 * (W8aerwL6 / xHPdpj0W) Bildirishnoma auditoriyasi ko'rinishi va kampaniya
 * navbati — faqat SUPERADMIN/ADMIN.
 *
 * ⚠️ MARSHRUT TARTIBI: bu controller modulda NotificationGatewayController
 * dan OLDIN ro'yxatga olinadi — aks holda `GET /notifications/campaigns`
 * u yerdagi `GET /notifications/:id` (telegram config) ga tushardi.
 *
 * ⚠️ identity'ning ichki auditoriya resolveri (ism/telefon qaytaradi) bu
 * yerda OCHILMAYDI — preview faqat sonlarni qaytaradi.
 */
@ApiTags('Notification campaigns')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
export class NotificationCampaignGatewayController {
  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  private send<T = unknown>(
    cmd: string,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.notificationClient
        .send<T>({ cmd }, payload)
        .pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Notification service response timeout',
        );
      }
      throw error;
    });
  }

  private actor(req: AuthedRequest) {
    return { id: req.user?.sub ?? null, roles: req.user?.roles ?? [] };
  }

  @Post('audience/preview')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Yuborishdan OLDIN: aniq qabul qiluvchilar soni, rollar kesimi, kanal bo‘yicha yaroqlilar (hech narsa yuborilmaydi)',
  })
  @ApiBody({ type: AudiencePreviewRequestDto })
  previewAudience(@Body() dto: AudiencePreviewRequestDto) {
    // Katta auditoriya sahifalab sanaladi — 8 s emas.
    return this.send('notification.audience.preview', { ...dto }, 30_000);
  }

  @Post('campaigns')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Ommaviy yuborish — darhol 202 { campaign_id }, fonda partiyalab (Idempotency-Key majburiy; takror — mavjud kampaniya)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: CreateNotificationCampaignRequestDto })
  createCampaign(
    @Body() dto: CreateNotificationCampaignRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.send('notification.campaign.create', {
      ...dto,
      idempotency_key: idempotencyKey?.trim() || dto.idempotency_key || null,
      requester: this.actor(req),
    });
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'Kampaniyalar tarixi (yangilari birinchi)' })
  listCampaigns(@Query() query: ListNotificationCampaignsQueryDto) {
    return this.send('notification.campaign.list', { ...query });
  }

  @Get('campaigns/:id')
  @ApiOperation({
    summary:
      'Kampaniya progressi: status, total/sent/failed/skipped, progress_pct',
  })
  @ApiParam({ name: 'id', example: '7' })
  getCampaign(@Param('id') id: string) {
    return this.send('notification.campaign.get', { id });
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bekor qilish — keyingi partiyalar boshlanmaydi',
  })
  @ApiParam({ name: 'id', example: '7' })
  cancelCampaign(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.send('notification.campaign.cancel', {
      id,
      requester: this.actor(req),
    });
  }
}
