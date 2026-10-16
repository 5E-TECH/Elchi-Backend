import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  Group_type,
  IsNotificationType,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
} from '@app/common';
import { AudienceSegmentDto } from './notification-campaign.swagger.dto';

export class CreateTelegramMarketRequestDto {
  @ApiProperty({ example: '2' })
  @IsString()
  @Matches(/^\d+$/)
  market_id!: string;

  @ApiProperty({ example: '-1001234567890' })
  @IsString()
  group_id!: string;

  @ApiProperty({ enum: Group_type, example: Group_type.CREATE })
  @IsEnum(Group_type)
  group_type!: Group_type;

  // (bOMYoOtV) `token` YO'Q: bot tokeni so'rov tanasidan ham, bazadan ham
  // olinmaydi (faqat env). Yuborilsa 400 (forbidNonWhitelisted).

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  is_active?: boolean;
}

export class FindTelegramMarketsQueryDto {
  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class UpdateTelegramMarketRequestDto {
  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  id?: string;

  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '-1001234567890' })
  @IsOptional()
  @IsString()
  group_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CANCEL })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  // (bOMYoOtV) `token` YO'Q: bot tokeni so'rov tanasidan ham, bazadan ham
  // olinmaydi (faqat env). Yuborilsa 400 (forbidNonWhitelisted).

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  is_active?: boolean;
}

export class DeleteTelegramMarketRequestDto {
  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  id?: string;

  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;
}

export class SendNotificationRequestDto {
  @ApiPropertyOptional({ example: '2' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '-1001234567890' })
  @IsOptional()
  @IsString()
  group_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  // (n0kLbx3d / bOMYoOtV) `token` ATAYLAB YO'Q: yuborilsa 400
  // (forbidNonWhitelisted). Bot tokeni FAQAT env'dan — server ixtiyoriy bot
  // tokeni bilan tashqi so'rov yuboruvchi vositaga aylanmasin.

  @ApiProperty({ example: 'Buyurtma yaratildi: #123' })
  @IsString()
  message!: string;

  @ApiPropertyOptional({
    enum: ['Markdown', 'MarkdownV2', 'HTML'],
    example: 'HTML',
  })
  @IsOptional()
  @IsString()
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  disable_web_page_preview?: boolean;
}

export class ConnectTelegramByTokenRequestDto {
  @ApiProperty({
    example: 'q3Jx0Yd2c1Kk9mZ4o7Hn5bP1wE8rT6uA0sD3fG5hJ2k',
    description:
      "(6jXw0DDr / 4TfLyTrL) BIR MARTALIK guruh ulash kodi — `POST /telegram/link-code { purpose: 'market_group', group_type }` javobidagi `token` (43 belgi, 10 daqiqa). " +
      'Matnli `group_token-…` (market tokeni) va `group_token-<marketId>` endi rad etiladi (400). ' +
      'Mavjud (market, guruh turi) ulanishi va boshqa marketga ulangan guruh hech qachon ustidan yozilmaydi: almashtirish faqat PATCH/DELETE /notifications/:id.',
  })
  @IsString()
  text!: string;

  @ApiProperty({ example: '-1001234567890' })
  @IsString()
  group_id!: string;
}

// ==================== In-app notification inbox ====================

/**
 * Dispatch'ning Telegram relay nishoni (n0kLbx3d): faqat shu maydonlar —
 * `token` (yoki boshqa noma'lum maydon) yuborilsa 400.
 */
export class DispatchTelegramTargetDto {
  @ApiPropertyOptional({
    example: '2',
    description: 'Market id (ulangan guruh)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '-1001234567890' })
  @IsOptional()
  @IsString()
  group_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;
}

export class DispatchNotificationRequestDto {
  @ApiPropertyOptional({
    example: '42',
    description: 'Single recipient user id',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  recipient_id?: string;

  @ApiPropertyOptional({
    example: ['42', '43'],
    description: 'Explicit recipient list',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  // (BoMa1A1R) har element faqat raqam — "abc" bigint ustunigacha yetmasin.
  @Matches(/^\d+$/, { each: true })
  recipient_ids?: string[];

  @ApiPropertyOptional({
    example: ['courier', 'manager'],
    description: 'Target all users of these roles',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'Send to every active user',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  broadcast?: boolean;

  // (W8aerwL6) Mijozlarni nishonlash: `include_customers` + segment YOKI
  // `confirm_all_customers` (aks holda 400). `roles:['customer']` ham shu bilan.
  @ApiPropertyOptional({
    example: false,
    description:
      'Mijozlarni ham — segment YOKI confirm_all_customers bilan (aks holda 400)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  include_customers?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Segmentsiz BARCHA mijozlarga — aniq tasdiq',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  confirm_all_customers?: boolean;

  @ApiPropertyOptional({
    type: AudienceSegmentDto,
    description: 'Mijoz segmenti (buyurtmalar bo‘yicha) — faqat mijozlarga',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AudienceSegmentDto)
  segment?: AudienceSegmentDto;

  @ApiProperty({
    example: 'order.sold',
    description:
      'Event key `{domain}.{event}` — GET /notifications/types katalogidan, ' +
      'yoki vaqtinchalik `x.` prefiksli tur (masalan `x.test`). Boshqasi 400.',
  })
  @IsString()
  @MaxLength(120)
  @IsNotificationType()
  type!: string;

  @ApiPropertyOptional({
    enum: NotificationCategory,
    example: NotificationCategory.ORDER,
  })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({
    enum: NotificationPriority,
    example: NotificationPriority.NORMAL,
  })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiProperty({ example: 'Buyurtma sotildi' })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: '#123 buyurtma muvaffaqiyatli yetkazildi.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  @ApiPropertyOptional({ example: { order_id: '123' } })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ example: '/orders/123' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  link?: string;

  @ApiPropertyOptional({
    enum: NotificationChannel,
    isArray: true,
    example: [NotificationChannel.IN_APP, NotificationChannel.REALTIME],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];

  @ApiPropertyOptional({
    example: 'order:123:status',
    description:
      "Dedupe/collapse key (ixtiyoriy). Berilmasa katalogdagi group_key_pattern + data dan hosil qilinadi (masalan order.* -> order:{order_id}:status); shablonli turda data o'zgaruvchisi yetishmasa — 400. Shablonsiz tur (category.manual va h.k.) — har dispatch alohida qator.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  group_key?: string;

  @ApiPropertyOptional({
    type: DispatchTelegramTargetDto,
    description: 'Optional telegram relay target (token qabul qilinmaydi)',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DispatchTelegramTargetDto)
  telegram?: DispatchTelegramTargetDto;

  /**
   * (7Vozou5x) Har "Yuborish" bosilishi uchun bitta UUID (qayta urinishda
   * O'SHA qiymat). U `dispatch_id` bo'ladi: 504 dan keyin
   * `GET /notifications/sent/:dispatch_id` bilan natijani tekshirish mumkin,
   * ayni id bilan qayta yuborish esa IKKINCHI marta yubormaydi.
   */
  @ApiPropertyOptional({
    example: '0b7f6f5e-3c1a-4c6e-9b1d-2f0a6c1e9d42',
    description:
      'Client UUID per "Send" click (reuse on retry) — becomes dispatch_id; duplicate → stored result, no resend',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'client_request_id must be a UUID',
  })
  client_request_id?: string;
}

export class InboxQueryDto {
  @ApiPropertyOptional({ example: false, description: 'Filter by read state' })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  is_read?: boolean;

  @ApiPropertyOptional({ example: 'order.sold' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({
    example: true,
    description: '"Faqat muhim" — critical + high (priority dan ustun)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === 'true' || value === '1'
      ? true
      : value === false || value === 'false' || value === '0'
        ? false
        : value,
  )
  @IsBoolean()
  important?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

// ==================== Web Push ====================

export class PushSubscriptionKeysDto {
  @ApiProperty({
    example:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  p256dh!: string;

  @ApiProperty({ example: 'tBHItJI5svbpez7KI4CCXg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  auth!: string;
}

export class SubscribePushRequestDto {
  @ApiProperty({
    example: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bH...',
    description: 'PushSubscription.endpoint (brauzer beradi)',
  })
  @IsString()
  @Matches(/^https:\/\//i, { message: 'endpoint must be an https URL' })
  @MaxLength(2048)
  endpoint!: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @ApiPropertyOptional({
    example: 'Mozilla/5.0 (Linux; Android 14) ...',
    description: 'Serverda 256 belgiga kesiladi',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  user_agent?: string;

  @ApiPropertyOptional({
    enum: ['android', 'ios', 'desktop'],
    example: 'android',
  })
  @IsOptional()
  @IsIn(['android', 'ios', 'desktop'])
  platform?: 'android' | 'ios' | 'desktop';

  @ApiPropertyOptional({
    example: false,
    description:
      "display-mode: standalone (o'rnatilgan PWA) ichidan obuna bo'ldimi",
  })
  @IsOptional()
  @IsBoolean()
  is_standalone?: boolean;
}

/** (mP1WGG1W) Bitta sozlama: kategoriya yoki tur × kanal. */
export class NotificationPreferenceItemDto {
  @ApiProperty({
    example: 'order',
    description: 'Kategoriya (order, marketing, …) yoki aniq tur (order.sold)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  scope!: string;

  @ApiProperty({
    enum: ['all', 'in_app', 'realtime', 'push', 'sms', 'email'],
    example: 'push',
  })
  @IsIn(['all', 'in_app', 'realtime', 'push', 'sms', 'email'])
  channel!: string;

  @ApiProperty({
    example: false,
    nullable: true,
    description: 'null — sozlamani olib tashlash (sukutga qaytish)',
  })
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  enabled!: boolean | null;
}

export class UpdateNotificationPreferencesRequestDto {
  @ApiProperty({ type: [NotificationPreferenceItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceItemDto)
  items!: NotificationPreferenceItemDto[];
}

export class UnsubscribePushRequestDto {
  @ApiProperty({
    example: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bH...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  endpoint!: string;
}

// ==================== Telegram bog'lash (6jXw0DDr / 4TfLyTrL / 9uNhwTZp) ====================

export class TelegramLinkCodeRequestDto {
  @ApiPropertyOptional({
    enum: ['user', 'market_group'],
    example: 'user',
    description:
      "`user` (sukut) — o'z akkauntiga shaxsiy chat (t.me/<bot>?start=<kod>); `market_group` — market guruhi (t.me/<bot>?startgroup=<kod>).",
  })
  @IsOptional()
  @IsIn(['user', 'market_group'])
  purpose?: 'user' | 'market_group';

  @ApiPropertyOptional({
    example: '37',
    description:
      'Faqat `market_group` + admin/superadmin uchun MAJBURIY. Market va operator — o‘z marketi (server yechadi; boshqasi → 403).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ enum: Group_type, example: Group_type.CREATE })
  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;
}

export class TelegramAuthRequestDto {
  @ApiProperty({
    description:
      'Telegram Mini App `window.Telegram.WebApp.initData` (xom satr, o‘zgartirmasdan).',
    example:
      'query_id=AAH…&user=%7B%22id%22%3A123%7D&auth_date=1760000000&hash=…',
  })
  @IsString()
  @MaxLength(4096)
  init_data!: string;
}
