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
  Post,
  Put,
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
  CreateAudienceSegmentRequestDto,
  CreateNotificationCampaignRequestDto,
  ListNotificationCampaignsQueryDto,
} from './dto/notification-campaign.swagger.dto';
import {
  ListNotificationTemplatesQueryDto,
  ListSentNotificationsQueryDto,
  SentNotificationDetailQueryDto,
  TelegramBroadcastRequestDto,
  UpsertNotificationTemplateRequestDto,
} from './dto/notification-history.swagger.dto';

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

  /** (ebSV5oyP #7) Saqlangan segmentlar — keyingi kampaniyada qayta ishlatish. */
  @Get('audience/segments')
  @ApiOperation({ summary: 'Saqlangan auditoriya segmentlari' })
  listSegments() {
    return this.send('notification.audience.segments.list', {});
  }

  @Post('audience/segments')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Segmentni nom bilan saqlash (faqat shart; son jonli — preview audience_segment_id bilan)',
  })
  @ApiBody({ type: CreateAudienceSegmentRequestDto })
  createSegment(
    @Body() dto: CreateAudienceSegmentRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.send(
      'notification.audience.segments.create',
      { ...dto, requester: this.actor(req) },
      30_000,
    );
  }

  @Delete('audience/segments/:id')
  @ApiOperation({ summary: 'Saqlangan segmentni o‘chirish' })
  @ApiParam({ name: 'id', example: '3' })
  deleteSegment(@Param('id') id: string) {
    return this.send('notification.audience.segments.delete', { id });
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

  /**
   * (7Vozou5x) Yuborilgan xabarlar tarixi — qo'lda dispatch'lar (bitta
   * dispatch = bitta qator). activity_logs EMAS — o'z jadvali.
   * ⚠️ `GET /notifications/:id` (telegram config) dan OLDIN (shu controller).
   */
  /**
   * (rCFZAmOz #3) Telegram e'loni (BeePost bot-broadcast pariteti): tanlangan
   * auditoriyaga SHAXSIY chat orqali (users.telegram_id). Oddiy dispatch
   * (`system.manual`, kanallar in_app + telegram) — inbox qatori yetkazish
   * yozuvi. Javobda `by_channel.telegram` (navbatga qo'yilgan) va
   * `channel_status.telegram` (`queued` / `skipped` = chat ulanmagan);
   * yakuniy sent/failed — `GET /notifications/sent/:dispatch_id`.
   */
  @Post('telegram/broadcast')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Telegram broadcast to linked personal chats (roles/broadcast/recipient_ids); counts in response, final sent/failed in /notifications/sent/:id',
  })
  @ApiBody({ type: TelegramBroadcastRequestDto })
  telegramBroadcast(
    @Body() dto: TelegramBroadcastRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.send('notification.dispatch', {
      ...dto,
      type: 'system.manual',
      channels: ['in_app', 'telegram'],
      requester: this.actor(req),
    });
  }

  /**
   * (C4R3YyvH #6) Shablonlar reyestri: DB'dagilar (`source: 'db'`) va DB'da
   * 'uz' yozuvi yo'q katalog turlarining o'rnatilgan sukutlari (`defaults`,
   * faqat ko'rsatish uchun — dispatch'da qo'llanmaydi). Har birida SMS
   * `encoding`/`parts` (160 lotin / 70 kirill).
   */
  @Get('templates')
  @ApiOperation({
    summary:
      'Bildirishnoma shablonlari (uz/ru/en): DB + o‘rnatilgan uz sukutlar, SMS encoding/parts bilan',
  })
  listTemplates(@Query() query: ListNotificationTemplatesQueryDto) {
    return this.send('notification.templates.list', { ...query });
  }

  @Put('templates')
  @ApiOperation({
    summary:
      'Shablonni yaratish/yangilash (code+lang+channel). Fail-closed o‘zgaruvchilar, SMS’ga ketadiganida PII taqiqlangan',
  })
  @ApiBody({ type: UpsertNotificationTemplateRequestDto })
  upsertTemplate(
    @Body() dto: UpsertNotificationTemplateRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.send('notification.templates.upsert', {
      ...dto,
      requester: this.actor(req),
    });
  }

  @Get('sent')
  @ApiOperation({
    summary:
      'Yuborilgan xabarlar tarixi: sana, sarlavha, kim yubordi, qabul qiluvchilar, kanal natijasi',
  })
  listSent(@Query() query: ListSentNotificationsQueryDto) {
    return this.send('notification.dispatch_history.list', { ...query });
  }

  @Get('sent/:dispatch_id')
  @ApiOperation({
    summary:
      'Bitta dispatch: to‘liq matn, kanal × holat (jonli), yetkazilmaganlar (ism + rol + sabab)',
  })
  @ApiParam({
    name: 'dispatch_id',
    example: '0b7f6f5e-3c1a-4c6e-9b1d-2f0a6c1e9d42',
  })
  getSent(
    @Param('dispatch_id') dispatchId: string,
    @Query() query: SentNotificationDetailQueryDto,
  ) {
    return this.send('notification.dispatch_history.get', {
      ...query,
      dispatch_id: dispatchId,
    });
  }
}
