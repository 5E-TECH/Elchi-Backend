import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  GoneException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { Roles as RoleEnum } from '@app/common';
import {
  ConnectTelegramByTokenRequestDto,
  DispatchNotificationRequestDto,
  FindTelegramMarketsQueryDto,
  InboxQueryDto,
  SendNotificationRequestDto,
  MyTelegramGroupStatusDto,
  SubscribePushRequestDto,
  TelegramMarketPublicDto,
  UnsubscribePushRequestDto,
  UpdateNotificationPreferencesRequestDto,
  UpdateTelegramMarketRequestDto,
} from './dto/notification.swagger.dto';

/** (qXlFQp8Q) POST /notifications (qo'lda guruh ID) yopilgan — 410 matni. */
export const MANUAL_GROUP_CREATE_GONE_MESSAGE =
  "Guruh ID'sini qo'lda kiritib ulash yopilgan. Guruh faqat bir martalik bot havolasi orqali ulanadi: POST /telegram/link-code { purpose: 'market_group' } → guruhda /start <kod> (yoki POST /notifications/connect-by-token).";

interface AuthedRequest {
  user?: { sub?: string; roles?: string[] };
}

@ApiTags('Notification')
@Controller('notifications')
export class NotificationGatewayController {
  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  private async send<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.notificationClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Bildirishnoma xizmati vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }

  private requireUserId(req: AuthedRequest): string {
    const id = req.user?.sub;
    if (!id)
      throw new UnauthorizedException(
        "Foydalanuvchi autentifikatsiyadan o'tmagan",
      );
    return String(id);
  }

  /** The authenticated user as an audit actor for write operations. */
  private auditActor(req: AuthedRequest) {
    return { id: req.user?.sub ?? null, roles: req.user?.roles ?? [] };
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Notification service health check' })
  health() {
    return this.send({ cmd: 'notification.health' }, {});
  }

  // ==================== In-app inbox (current user) ====================
  // NOTE: these static-segment routes are declared BEFORE the telegram-config
  // `:id` routes so `/notifications/inbox` is not captured by `GET :id`.

  @Get('inbox')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Current user's notification inbox" })
  listInbox(@Req() req: AuthedRequest, @Query() query: InboxQueryDto) {
    return this.send(
      { cmd: 'notification.inbox.list' },
      { ...query, recipient_id: this.requireUserId(req) },
    );
  }

  @Get('inbox/counts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Kategoriya bo‘yicha jami/o‘qilmagan va muhim o‘qilmaganlar soni',
  })
  inboxCounts(@Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.inbox.counts' },
      { recipient_id: this.requireUserId(req) },
    );
  }

  @Get('inbox/unread-count')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user unread notification count' })
  unreadCount(@Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.inbox.unread_count' },
      { recipient_id: this.requireUserId(req) },
    );
  }

  @Get('inbox/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one of my notifications' })
  @ApiParam({ name: 'id', example: '10' })
  findOneInbox(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.send(
      { cmd: 'notification.inbox.find_one' },
      { recipient_id: this.requireUserId(req), id },
    );
  }

  @Patch('inbox/read-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark all my notifications read' })
  markAllRead(@Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.inbox.mark_all_read' },
      { recipient_id: this.requireUserId(req) },
    );
  }

  @Patch('inbox/:id/read')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark one of my notifications read (or unread)' })
  @ApiParam({ name: 'id', example: '10' })
  markRead(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { read?: boolean },
  ) {
    return this.send(
      { cmd: 'notification.inbox.mark_read' },
      { recipient_id: this.requireUserId(req), id, read: body?.read ?? true },
    );
  }

  @Delete('inbox/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete one of my notifications' })
  @ApiParam({ name: 'id', example: '10' })
  deleteInbox(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.send(
      { cmd: 'notification.inbox.delete' },
      { recipient_id: this.requireUserId(req), id },
    );
  }

  // ==================== Sozlamalar (mP1WGG1W) — o'z sozlamasi ====================
  // `:id` marshrutlaridan OLDIN. Rol talab qilinmaydi; `user_id` FAQAT JWT'dan.

  @Get('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Current user's notification preferences" })
  getPreferences(@Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.preferences.get' },
      { user_id: this.requireUserId(req) },
    );
  }

  @Patch('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update current user preferences (critical types cannot be disabled → 400)',
  })
  @ApiBody({ type: UpdateNotificationPreferencesRequestDto })
  updatePreferences(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateNotificationPreferencesRequestDto,
  ) {
    return this.send(
      { cmd: 'notification.preferences.update' },
      { items: dto.items, user_id: this.requireUserId(req) },
    );
  }

  // ==================== Web Push (current user's device) ====================
  // Also declared BEFORE the `:id` routes.

  @Get('push/public-key')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'VAPID public key for PushManager.subscribe (never the private key)',
  })
  pushPublicKey() {
    return this.send({ cmd: 'notification.push.public_key' }, {});
  }

  @Post('push/subscribe')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Save this browser/device push subscription for the current user (idempotent by endpoint)',
  })
  @ApiBody({ type: SubscribePushRequestDto })
  pushSubscribe(
    @Req() req: AuthedRequest,
    @Body() dto: SubscribePushRequestDto,
  ) {
    return this.send(
      { cmd: 'notification.push.subscribe' },
      { ...dto, user_id: this.requireUserId(req) },
    );
  }

  @Delete('push/subscribe')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Remove one of the current user's push subscriptions (call BEFORE logout revokes the token)",
  })
  @ApiBody({ type: UnsubscribePushRequestDto })
  pushUnsubscribe(
    @Req() req: AuthedRequest,
    @Body() dto: UnsubscribePushRequestDto,
  ) {
    return this.send(
      { cmd: 'notification.push.unsubscribe' },
      { endpoint: dto.endpoint, user_id: this.requireUserId(req) },
    );
  }

  /**
   * (rCFZAmOz #1 / 9uNhwTZp) Shaxsiy Telegram'ni ulash — tizimga kirgan
   * foydalanuvchi O'Z akkaunti uchun BIR MARTALIK havola oladi (10 daqiqa;
   * `user_id` va rol faqat JWT'dan). Bot `/start <kod>` → `users.telegram_id`.
   * Yangi nom: `POST /users/me/telegram/link-code` (bir xil javob).
   */
  @Post('telegram/link')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Personal Telegram link for the current user: { token, deep_link, command, expires_at } (one-time, 10 min)',
  })
  telegramLink(@Req() req: AuthedRequest & { ip?: string }) {
    return this.send(
      { cmd: 'notification.telegram.link_token' },
      {
        user_id: this.requireUserId(req),
        roles: req.user?.roles ?? [],
        ip: req.ip ?? null,
      },
    );
  }

  /**
   * Bildirishnoma turlari reyestri (Eh8y21Ha) — frontend katalogni qo'lda
   * takrorlamasin, shu yerdan olsin. Autentifikatsiya bilan (`@Public` emas).
   * ⚠️ `:id` marshrutidan OLDIN e'lon qilingan.
   */
  @Get('types')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Notification types catalog (key, category, priority, default_channels, label_uz, user_can_mute)',
  })
  listTypes() {
    return this.send({ cmd: 'notification.types.list' }, {});
  }

  /**
   * (KJNHAlGW) Market kabineti «Telegram guruhi» kartasi va ulash oynasi
   * («Guruh ulanishi kutilmoqda…» — har 3-5 soniyada so'raydi). market_id
   * FAQAT tokendan (MARKET — sub, MARKET_OPERATOR — user.market_id);
   * query/body'dagi market_id qabul qilinmaydi.
   * ⚠️ `:id` marshrutidan OLDIN e'lon qilingan.
   */
  @Get('me/telegram-groups')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Market o'z Telegram guruhlari holati: data[] — har doim ikkala tur (create, cancel): { group_type, linked, is_active, linked_at, inactive_reason }",
  })
  @ApiOkResponse({
    description: 'data[] elementi',
    type: MyTelegramGroupStatusDto,
    isArray: true,
  })
  myTelegramGroups(@Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.telegram.my_groups' },
      { requester: this.auditActor(req) },
    );
  }

  @Post('dispatch')
  // (3SeRYFqx) Tana statusCode i HTTP holatiga (takror — 200, yangi — 201).
  @UseInterceptors(BodyStatusCodeInterceptor)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manually dispatch a notification (admin/testing)' })
  @ApiBody({ type: DispatchNotificationRequestDto })
  dispatch(
    @Body() dto: DispatchNotificationRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.send(
      { cmd: 'notification.dispatch' },
      { ...dto, requester: this.auditActor(req) },
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get notification configs (data.items[] — TelegramMarketPublicDto; inactive_reason/inactive_at bilan, G085w5Qr)',
  })
  @ApiOkResponse({
    description: 'data.items[] elementi',
    type: TelegramMarketPublicDto,
  })
  @ApiQuery({ name: 'market_id', required: false })
  @ApiQuery({ name: 'group_type', required: false })
  @ApiQuery({ name: 'is_active', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listNotifications(@Query() query: FindTelegramMarketsQueryDto) {
    return this.send({ cmd: 'notification.telegram.find_all' }, query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get one notification config by id (inactive_reason/inactive_at bilan, G085w5Qr)',
  })
  @ApiOkResponse({ description: 'data', type: TelegramMarketPublicDto })
  @ApiParam({ name: 'id', example: '10' })
  findOneNotification(@Param('id') id: string) {
    return this.send({ cmd: 'notification.telegram.find_one' }, { id });
  }

  /**
   * (qXlFQp8Q, ega qarori 2026-10-19 notif-groups S4) Guruh ID'sini QO'LDA
   * yozib ulash yopildi — bot a'zo bo'lmagan / begona guruhni marketga
   * bog'lash yo'li edi. Frontend iste'molchisi yo'q (Elchi-Frontend dev:
   * faqat GET / PATCH { is_active } / DELETE). Guruh faqat bir martalik bot
   * havolasi orqali ulanadi: POST /telegram/link-code { purpose:
   * 'market_group' } → guruhda /start <kod> yoki POST
   * /notifications/connect-by-token. Bu marshrut 410 Gone qaytaradi.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary:
      "YOPILGAN (410 Gone, qXlFQp8Q): guruh ID'sini qo'lda yozib ulash olib tashlandi. Guruh faqat bir martalik bot havolasi orqali ulanadi — POST /telegram/link-code { purpose: 'market_group' } → /start <kod> yoki POST /notifications/connect-by-token.",
  })
  createNotification(): never {
    throw new GoneException(MANUAL_GROUP_CREATE_GONE_MESSAGE);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Telegram guruhini faollashtirish / o'chirish — FAQAT { is_active } (qXlFQp8Q). group_id / market_id / group_type yuborilsa 400; guruhni almashtirish — o'chirib, bot havolasi orqali qayta ulash. is_active=false → inactive_reason='manual'.",
  })
  @ApiParam({ name: 'id', example: '10' })
  @ApiBody({ type: UpdateTelegramMarketRequestDto })
  @ApiOkResponse({ description: 'data', type: TelegramMarketPublicDto })
  updateNotification(
    @Param('id') id: string,
    @Body() dto: UpdateTelegramMarketRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.send(
      { cmd: 'notification.telegram.update' },
      { ...dto, id, requester: this.auditActor(req) },
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete notification config' })
  @ApiParam({ name: 'id', example: '10' })
  deleteNotification(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.send(
      { cmd: 'notification.telegram.delete' },
      { id, requester: this.auditActor(req) },
    );
  }

  @Post('connect-by-token')
  // (3SeRYFqx #1) Xato — 400/404 standart konvert (statusCode + message);
  // muvaffaqiyat — 201.
  @UseInterceptors(BodyStatusCodeInterceptor)
  @UseGuards(JwtAuthGuard, RolesGuard)
  // (6jXw0DDr #7 / 4TfLyTrL #5) REGISTRATOR olib tashlandi.
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Connect telegram group by one-time group link code (POST /telegram/link-code { purpose: 'market_group' }). Noto'g'ri token — 400, market topilmadi — 404 (standart { statusCode, message }).",
  })
  @ApiBody({ type: ConnectTelegramByTokenRequestDto })
  connectByToken(@Body() dto: ConnectTelegramByTokenRequestDto) {
    return this.send({ cmd: 'notification.telegram.connect_by_token' }, dto);
  }

  @Post('send')
  // (3SeRYFqx #2 / 9HIaV80X) Hammasi ketdi — 200, navbatda (429/5xx, outbox
  // qayta yuboradi) — 202, aralash — 207, hech biri (403/400) — 502.
  @UseInterceptors(BodyStatusCodeInterceptor)
  @UseGuards(JwtAuthGuard, RolesGuard)
  // (bOMYoOtV #3) REGISTRATOR olib tashlandi — ochiq relay yopildi.
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary:
      "ESKIRGAN (TgYRqaTk): faqat qo'lda guruh relay'i — servislar `notification.dispatch` ishlatadi. Send notification to telegram group(s) — faqat superadmin/admin. Bot tokeni faqat server env; `token` qabul qilinmaydi (400). 200 — yuborildi, 202 — navbatda (qayta urinadi), 207 — aralash, 502 — hech biri.",
  })
  @ApiBody({ type: SendNotificationRequestDto })
  sendNotification(
    @Body() dto: SendNotificationRequestDto,
    @Req() req: AuthedRequest,
  ) {
    // (n0kLbx3d) requester — notification-service rol doirasini tekshiradi.
    return this.send(
      { cmd: 'notification.send' },
      { ...dto, requester: this.auditActor(req) },
    );
  }
}
