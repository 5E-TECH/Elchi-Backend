import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** (7Vozou5x) Tarix holatlari — notification-service bilan bir xil. */
export const DISPATCH_HISTORY_STATUS_VALUES = [
  'running',
  'sent',
  'partial',
  'inbox_only',
  'skipped',
  'failed',
] as const;

/** `GET /notifications/sent` (7Vozou5x). */
export class ListSentNotificationsQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: DISPATCH_HISTORY_STATUS_VALUES })
  @IsOptional()
  @IsIn(DISPATCH_HISTORY_STATUS_VALUES)
  status?: string;

  @ApiPropertyOptional({ example: 'system.manual' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  type?: string;

  @ApiPropertyOptional({ example: '1', description: 'Yuborgan admin id' })
  @IsOptional()
  @Matches(/^\d+$/)
  created_by?: string;
}

/** `GET /notifications/sent/:dispatch_id` — "Yetkazilmaganlar" sahifasi. */
export class SentNotificationDetailQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * `POST /notifications/telegram/broadcast` (rCFZAmOz #3) — nishon dispatch
 * bilan bir xil (roles / broadcast / recipient_ids), kamida bittasi SHART
 * (aks holda notification-service 400).
 */
export class TelegramBroadcastRequestDto {
  @ApiProperty({ example: 'Ertaga ish kuni' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: 'Soat 9:00 da filialda yig‘ilish' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  @ApiPropertyOptional({ example: ['courier', 'market'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ description: 'Barcha xodimlar' })
  @IsOptional()
  @IsBoolean()
  broadcast?: boolean;

  @ApiPropertyOptional({ example: ['42', '43'] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @Matches(/^\d+$/, { each: true })
  recipient_ids?: string[];

  @ApiPropertyOptional({
    example: '0b7f6f5e-3c1a-4c6e-9b1d-2f0a6c1e9d42',
    description: 'Har "Yuborish" uchun bitta UUID (qayta urinishda o‘sha)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'client_request_id must be a UUID',
  })
  client_request_id?: string;
}

/** (C4R3YyvH) Shablon tillari va kanallari — notification-service bilan bir xil. */
export const TEMPLATE_LANGUAGE_VALUES = ['uz', 'ru', 'en'] as const;
export const TEMPLATE_CHANNEL_VALUES = [
  'realtime',
  'telegram',
  'sms',
  'email',
  'push',
] as const;

/** `GET /notifications/templates` (C4R3YyvH). */
export class ListNotificationTemplatesQueryDto {
  @ApiPropertyOptional({ example: 'order.sold' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  code?: string;

  @ApiPropertyOptional({ enum: TEMPLATE_LANGUAGE_VALUES })
  @IsOptional()
  @IsIn(TEMPLATE_LANGUAGE_VALUES)
  lang?: string;
}

/**
 * `PUT /notifications/templates` (C4R3YyvH) — (code, lang, channel) bo'yicha
 * yaratadi yoki yangilaydi. `code` — katalogdagi tur.
 */
export class UpsertNotificationTemplateRequestDto {
  @ApiProperty({ example: 'order.sold' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  code!: string;

  @ApiProperty({ enum: TEMPLATE_LANGUAGE_VALUES, example: 'ru' })
  @IsIn(TEMPLATE_LANGUAGE_VALUES)
  lang!: string;

  @ApiPropertyOptional({
    enum: TEMPLATE_CHANNEL_VALUES,
    nullable: true,
    description:
      'null — umumiy (inbox qatori, u SMS/Telegram/push ga ham ketadi)',
  })
  @IsOptional()
  @IsIn([...TEMPLATE_CHANNEL_VALUES, null])
  channel?: string | null;

  @ApiProperty({ example: 'Заказ продан' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: 'Заказ #{{order_number}} продан.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string | null;

  @ApiPropertyOptional({ example: ['order_number'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_]{1,64}$/, { each: true })
  required_vars?: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
