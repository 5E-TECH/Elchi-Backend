import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const MESSAGE_CLASSES = ['transactional', 'promo', 'security'] as const;
const LANGS = ['uz', 'ru', 'en'] as const;
const ID_RE = /^\d+$/;

// ==================== OTP (rkz0yBxr) ====================

export class OtpRequestDto {
  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @MaxLength(32)
  phone_number!: string;

  @ApiPropertyOptional({ enum: ['login', 'phone_verify'], example: 'login' })
  @IsOptional()
  @IsIn(['login', 'phone_verify'])
  purpose?: 'login' | 'phone_verify';
}

export class OtpVerifyDto extends OtpRequestDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code — 6 raqam' })
  code!: string;
}

// ==================== Provayder akkaunti ====================

export class UpsertSmsAccountDto {
  @ApiProperty({ enum: ['eskiz', 'playmobile'], example: 'eskiz' })
  @IsIn(['eskiz', 'playmobile'])
  provider!: 'eskiz' | 'playmobile';

  @ApiProperty({ enum: ['default', 'otp'], example: 'default' })
  @IsIn(['default', 'otp'])
  sender_profile!: 'default' | 'otp';

  @ApiProperty({ example: 'ops@elchipochta.uz' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  login!: string;

  @ApiProperty({
    example: '••••••••',
    description: 'Faqat yoziladi, hech qachon qaytmaydi',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password!: string;

  @ApiProperty({
    example: 'ELCHI',
    description: 'Provayderda tasdiqlangan alfa-nom',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  sender!: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

// ==================== Shablonlar (nkhURiKX) ====================

export class UpsertSmsTemplateDto {
  @ApiProperty({ example: 'order.delivered' })
  @IsString()
  @Matches(/^[a-z0-9_.-]{2,64}$/)
  code!: string;

  @ApiProperty({ enum: MESSAGE_CLASSES, example: 'transactional' })
  @IsIn(MESSAGE_CLASSES)
  message_class!: (typeof MESSAGE_CLASSES)[number];

  @ApiProperty({ enum: LANGS, example: 'uz' })
  @IsIn(LANGS)
  lang!: (typeof LANGS)[number];

  @ApiProperty({
    example: "Buyurtma #{{order_number}} yetkazildi. Summa: {{amount}} so'm.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  text!: string;

  @ApiPropertyOptional({ example: ['order_number', 'amount'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  required_vars?: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ApproveSmsTemplateDto {
  @ApiProperty({
    example: '12345',
    description: 'Provayder tasdiqlagan shablon id',
  })
  @IsString()
  @MaxLength(64)
  provider_template_id!: string;
}

// ==================== Kampaniya (sVByLMnt) ====================

export class SmsCampaignSegmentDto {
  @ApiPropertyOptional({ example: '3' })
  @IsOptional()
  @Matches(ID_RE)
  market_id?: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @Matches(ID_RE)
  region_id?: string;

  @ApiPropertyOptional({ example: '12' })
  @IsOptional()
  @Matches(ID_RE)
  district_id?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  last_order_from?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsISO8601()
  last_order_to?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  min_orders?: number;

  @ApiPropertyOptional({
    example: ['+998901234567'],
    description: "Segment o'rniga qo'lda ro'yxat",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  phones?: string[];
}

export class SmsCampaignDto {
  @ApiPropertyOptional({ enum: ['promo', 'transactional'], example: 'promo' })
  @IsOptional()
  @IsIn(['promo', 'transactional'])
  message_class?: 'promo' | 'transactional';

  @ApiPropertyOptional({ example: 'Yangi mavsum chegirmalari!' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  @ApiPropertyOptional({ example: 'promo.autumn' })
  @IsOptional()
  @Matches(/^[a-z0-9_.-]{2,64}$/)
  template_code?: string;

  @ApiPropertyOptional({ enum: LANGS, example: 'uz' })
  @IsOptional()
  @IsIn(LANGS)
  lang?: (typeof LANGS)[number];

  @ApiPropertyOptional({ example: { discount: '20%' } })
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;

  @ApiPropertyOptional({ type: SmsCampaignSegmentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SmsCampaignSegmentDto)
  segment?: SmsCampaignSegmentDto;
}

// ==================== Rozilik ====================

export class GrantSmsConsentDto {
  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ example: '1201' })
  @IsOptional()
  @Matches(ID_RE)
  customer_id?: string;

  @ApiProperty({ enum: ['shartnoma', 'veb-forma', 'buyurtma', 'operator'] })
  @IsIn(['shartnoma', 'veb-forma', 'buyurtma', 'operator'])
  source!: 'shartnoma' | 'veb-forma' | 'buyurtma' | 'operator';

  @ApiPropertyOptional({
    example: { note: "Telefon orqali og'zaki rozilik, qo'ng'iroq yozuvi #55" },
  })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class RevokeSmsConsentDto {
  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @MaxLength(32)
  phone!: string;
}

export class SmsReportQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01T00:00:00+05:00' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-01T00:00:00+05:00' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
