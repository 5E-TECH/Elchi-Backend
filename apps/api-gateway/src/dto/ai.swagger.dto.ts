import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * `/ai/*` admin endpointlari DTO'lari (wFSMEIIy, lYVuADRE; PLAN C8).
 */

/** Toshkent sanasi `YYYY-MM-DD` (oy 01-12, kun 01-31). */
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimOptional = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * `POST /ai/cap/raise` — global kunlik shiftni FAQAT BUGUN (Toshkent sanasi)
 * uchun bir martalik ko'tarish (wFSMEIIy #10). Amal ai_schema.activity_logs
 * ga audit sifatida yoziladi. Yuqori chegara (AI_CAP_RAISE_MAX_USD) ai-service
 * tomonda qo'llanadi.
 */
export class RaiseAiCapRequestDto {
  @ApiProperty({
    example: 10,
    minimum: 0.01,
    description:
      'Bugungi shiftga qo‘shiladigan summa (USD). ai-service AI_CAP_RAISE_MAX_USD dan oshirmaydi.',
  })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: "extra_usd son bo'lishi kerak" },
  )
  @Min(0.01, { message: "extra_usd kamida 0.01 bo'lishi kerak" })
  extra_usd!: number;

  @ApiProperty({
    example: 'Aksiya kuni — buyurtmalar ko‘p',
    maxLength: 255,
    description: 'Ko‘tarish sababi (auditga yoziladi).',
  })
  @Transform(trimString)
  @IsString({ message: "reason matn bo'lishi kerak" })
  @IsNotEmpty({ message: 'Sabab (reason) majburiy' })
  @MaxLength(255, { message: 'Sabab 255 belgidan oshmasligi kerak' })
  reason!: string;
}

/**
 * `GET /ai/usage/summary?from&to` — davr Toshkent sanalarida, ikkala chet ham
 * kiradi. Berilmasa oxirgi 30 kun (ai-service).
 */
export class AiUsageSummaryQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Boshlanish sanasi (YYYY-MM-DD, Toshkent).',
  })
  @Transform(trimOptional)
  @IsOptional()
  @IsString({ message: "from matn bo'lishi kerak" })
  @Matches(YMD_RE, { message: "from YYYY-MM-DD formatida bo'lishi kerak" })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-27',
    description: 'Tugash sanasi (YYYY-MM-DD, Toshkent), shu kun ham kiradi.',
  })
  @Transform(trimOptional)
  @IsOptional()
  @IsString({ message: "to matn bo'lishi kerak" })
  @Matches(YMD_RE, { message: "to YYYY-MM-DD formatida bo'lishi kerak" })
  to?: string;
}

/**
 * (Celz3rKJ) `GET /ai-usage/dashboard?fromDate&toDate` — "Moliyaviy balans →
 * AI xarajat" paneli. Davr Toshkent sanalarida, ikkala chet ham kiradi;
 * berilmasa oxirgi 30 kun (BeePost `ai-usage/dashboard` bilan bir xil nomlar).
 */
export class AiUsageDashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-15',
    description: 'Boshlanish sanasi (YYYY-MM-DD, Toshkent).',
  })
  @Transform(trimOptional)
  @IsOptional()
  @IsString({ message: "fromDate matn bo'lishi kerak" })
  @Matches(YMD_RE, { message: "fromDate YYYY-MM-DD formatida bo'lishi kerak" })
  fromDate?: string;

  @ApiPropertyOptional({
    example: '2026-10-14',
    description: 'Tugash sanasi (YYYY-MM-DD, Toshkent), shu kun ham kiradi.',
  })
  @Transform(trimOptional)
  @IsOptional()
  @IsString({ message: "toDate matn bo'lishi kerak" })
  @Matches(YMD_RE, { message: "toDate YYYY-MM-DD formatida bo'lishi kerak" })
  toDate?: string;
}

/**
 * NFiXfmq6 — `GET /ai-usage/margin?fromDate&toDate&marketId` ("AI xarajat va
 * marja"). `marketId` — faqat SUPERADMIN/ADMIN uchun filtr; MARKET roli
 * uchun e'tiborsiz (har doim o'z kesimi).
 */
export class AiUsageMarginQueryDto extends AiUsageDashboardQueryDto {
  @ApiPropertyOptional({
    example: '12',
    description:
      'Faqat shu market (admin/superadmin). MARKET uchun e’tiborsiz.',
  })
  @Transform(trimOptional)
  @IsOptional()
  @IsString({ message: "marketId matn bo'lishi kerak" })
  @Matches(/^\d{1,19}$/, { message: "marketId raqam bo'lishi kerak" })
  marketId?: string;
}

/** (Celz3rKJ) `GET /ai-usage/ai-orders?fromDate&toDate&limit` (limit 1..100). */
export class AiUsageAiOrdersQueryDto extends AiUsageDashboardQueryDto {
  @ApiPropertyOptional({ example: 100, minimum: 1, maximum: 100 })
  @Transform(({ value }: { value: unknown }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsOptional()
  @IsInt({ message: "limit butun son bo'lishi kerak" })
  @Min(1, { message: "limit kamida 1 bo'lishi kerak" })
  @Max(100, { message: 'limit 100 dan oshmasligi kerak' })
  limit?: number;
}
