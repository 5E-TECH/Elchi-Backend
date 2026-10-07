import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
  ValidateNested,
} from 'class-validator';
import {
  Group_type,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
} from '@app/common';

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

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

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

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

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

  @ApiPropertyOptional({ example: '123456:ABCDEF...' })
  @IsOptional()
  @IsString()
  token?: string;

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
    example: 'group_token-0123456789abcdef0123456789abcdef',
    description:
      "The market's secret market_tg_token (`group_token-<32 hex>`), readable only by SUPERADMIN/ADMIN via GET /users/:id. " +
      'Optional suffix `-create` (default) or `-cancel` selects the group type, e.g. `group_token-<32 hex>-cancel`. ' +
      'The old `group_token-<marketId>` form is rejected. A bind does NOT rotate the token (it stays the order-bot credential), ' +
      'and an existing (market, group type) binding is never overwritten: re-bind only via PATCH/DELETE /notifications/:id.',
  })
  @IsString()
  text!: string;

  @ApiProperty({ example: '-1001234567890' })
  @IsString()
  group_id!: string;
}

// ==================== In-app notification inbox ====================

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

  @ApiProperty({
    example: 'order.sold',
    description: 'Event key `{domain}.{event}`',
  })
  @IsString()
  @MaxLength(120)
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
    example: 'order-123',
    description: 'Dedupe/collapse key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  group_key?: string;

  @ApiPropertyOptional({ description: 'Optional telegram relay target' })
  @IsOptional()
  @IsObject()
  telegram?: {
    market_id?: string;
    group_id?: string;
    group_type?: Group_type;
    token?: string;
  };
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

export class UnsubscribePushRequestDto {
  @ApiProperty({
    example: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bH...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  endpoint!: string;
}
