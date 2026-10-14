import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IsNotificationType,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
} from '@app/common';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : value;

/**
 * (W8aerwL6) Mijoz segmenti — buyurtmalar bo'yicha (order-service). Faqat
 * mijozlarga qo'llanadi va `include_customers: true` bilan birga beriladi.
 */
export class AudienceSegmentDto {
  @ApiPropertyOptional({ example: '5', description: 'Buyurtma hududi' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  region_id?: string;

  @ApiPropertyOptional({ example: '41', description: 'Buyurtma tumani' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  district_id?: string;

  @ApiPropertyOptional({ example: '12', description: 'Market' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Oxirgi buyurtma shu sanadan keyin',
  })
  @IsOptional()
  @IsDateString()
  last_order_from?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Oxirgi buyurtma shu sanadan oldin ("uxlab qolgan" mijozlar)',
  })
  @IsOptional()
  @IsDateString()
  last_order_to?: string;

  @ApiPropertyOptional({ example: 2, description: 'Kamida shuncha buyurtma' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  min_orders?: number;
}

/** (W8aerwL6) Nishon maydonlari — dispatch, preview va kampaniya uchun umumiy. */
export class AudienceTargetFieldsDto {
  @ApiPropertyOptional({
    example: ['courier', 'superadmin'],
    description:
      "Rollar. `superadmin` ham bo'ladi; `customer` — faqat include_customers bilan",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'Barcha xodimlar (superadmin ham), mijozsiz',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  broadcast?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Mijozlarni ham nishonlash — segment YOKI confirm_all_customers bilan (aks holda 400)',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  include_customers?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Segmentsiz BARCHA mijozlarga — aniq tasdiq',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  confirm_all_customers?: boolean;

  @ApiPropertyOptional({ type: AudienceSegmentDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AudienceSegmentDto)
  segment?: AudienceSegmentDto;
}

/** `POST /notifications/audience/preview` — hech narsa yuborilmaydi. */
export class AudiencePreviewRequestDto extends AudienceTargetFieldsDto {
  @ApiPropertyOptional({ example: '42' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  recipient_id?: string;

  @ApiPropertyOptional({ example: ['42', '43'] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(5000)
  @Matches(/^\d+$/, { each: true })
  recipient_ids?: string[];
}

const CAMPAIGN_CHANNELS = [
  NotificationChannel.IN_APP,
  NotificationChannel.REALTIME,
  NotificationChannel.PUSH,
] as const;

/**
 * `POST /notifications/campaigns` (xHPdpj0W) — darhol 202 `{ campaign_id }`.
 * Idempotency-Key sarlavhasi (yoki `idempotency_key`) MAJBURIY.
 */
export class CreateNotificationCampaignRequestDto extends AudienceTargetFieldsDto {
  @ApiProperty({
    example: 'marketing.manual',
    description: 'GET /notifications/types katalogidan (yoki `x.` prefiksli)',
  })
  @IsString()
  @MaxLength(120)
  @IsNotificationType()
  type!: string;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiProperty({ example: 'Yangi tarif' })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: '1-noyabrdan yangi tariflar amal qiladi.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  @ApiPropertyOptional({ example: { promo: 'nov' } })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ example: '/tariffs' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  link?: string;

  @ApiPropertyOptional({
    enum: CAMPAIGN_CHANNELS,
    isArray: true,
    example: ['in_app', 'realtime'],
    description: 'Faqat in_app / realtime / push (SMS — alohida epik)',
  })
  @IsOptional()
  @IsArray()
  @IsIn(CAMPAIGN_CHANNELS, { each: true })
  channels?: NotificationChannel[];

  @ApiPropertyOptional({
    example: ['42', '43'],
    description:
      'Aniq ro‘yxat — roles/broadcast/include_customers bilan birga EMAS',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(5000)
  @Matches(/^\d+$/, { each: true })
  recipient_ids?: string[];

  @ApiPropertyOptional({
    example: '2026-10-20T09:00:00+05:00',
    description: 'Rejalashtirish (≤90 kun). Berilmasa — darhol',
  })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional({
    example: 'b4f1c2e0-campaign-1',
    description: 'Idempotency-Key sarlavhasi o‘rniga (sarlavha ustun)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotency_key?: string;
}

export class ListNotificationCampaignsQueryDto {
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

  @ApiPropertyOptional({
    enum: ['draft', 'queued', 'running', 'done', 'failed', 'cancelled'],
  })
  @IsOptional()
  @IsIn(['draft', 'queued', 'running', 'done', 'failed', 'cancelled'])
  status?: string;
}
