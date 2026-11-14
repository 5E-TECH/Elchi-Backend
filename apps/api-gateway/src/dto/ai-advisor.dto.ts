import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AI_ADVISOR_LIST_STATUSES,
  AI_ADVISOR_RULE_KEYS,
  AI_ADVISOR_SEVERITIES,
  AI_ADVISOR_SORT_FIELDS,
} from '@app/common';

/**
 * BE-5 (LhTIno57) — `/ai/advisor/*` DTO'lari.
 *
 * ⚠️ Ichki `@ValidateNested`/`@Min`/`@Max`/uzunlik dekoratorlari ATAYLAB
 * yo'q (shartnoma §3.1): class-validator xatosi KODSIZ 400 bo'ladi va FE
 * uni maydon ostiga qo'ya olmaydi. Oraliq, noma'lum kalit va `version`
 * tekshiruvi ai-service'da → `AI_ADVISOR_INVALID_RULE` /
 * `AI_ADVISOR_INVALID_SETTING {field}`.
 */
export class AiAdvisorSettingsPatchDto {
  @ApiProperty({
    description:
      'MAJBURIY (GET dagi `version`). Eskirgan — 409 AI_ADVISOR_SETTINGS_CONFLICT {version}; yo\'q — 400 AI_ADVISOR_INVALID_SETTING {field: "version"}.',
    example: 4,
    type: 'integer',
  })
  @IsOptional()
  version?: unknown;

  @ApiPropertyOptional({
    description:
      "Qisman: `{R1: {shortage_uzs: 30000}, R8: {enabled: false}}`. Maydonlar: `enabled`, `telegram`, qoida chegaralari (`limits.rules`). `severity` o'zgarmaydi (400 AI_ADVISOR_INVALID_SETTING).",
    example: { R1: { shortage_uzs: 30000 }, R8: { enabled: false } },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'x-owner BE-1 — hozircha qabul qilinmaydi (400 AI_ADVISOR_INVALID_SETTING).',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  telegram?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'x-owner BE-1 — hozircha qabul qilinmaydi (400 AI_ADVISOR_INVALID_SETTING).',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  budget?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'x-owner BE-1/BE-4 — hozircha qabul qilinmaydi (400 AI_ADVISOR_INVALID_SETTING).',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  schedule?: Record<string, unknown>;
}

/**
 * `GET /ai/advisor/alerts` — oddiy class-validator (kodsiz 400 yetarli:
 * qiymatlarni FE o'zi tanlaydi, §3.1). ai-service ham qayta tekshiradi.
 */
export class AiAdvisorAlertsQueryDto {
  @ApiPropertyOptional({
    enum: [...AI_ADVISOR_LIST_STATUSES],
    description: '`open` = new + seen',
  })
  @IsOptional()
  @IsIn([...AI_ADVISOR_LIST_STATUSES])
  status?: (typeof AI_ADVISOR_LIST_STATUSES)[number];

  @ApiPropertyOptional({ enum: [...AI_ADVISOR_SEVERITIES] })
  @IsOptional()
  @IsIn([...AI_ADVISOR_SEVERITIES])
  severity?: (typeof AI_ADVISOR_SEVERITIES)[number];

  @ApiPropertyOptional({ enum: [...AI_ADVISOR_RULE_KEYS] })
  @IsOptional()
  @IsIn([...AI_ADVISOR_RULE_KEYS])
  rule_key?: (typeof AI_ADVISOR_RULE_KEYS)[number];

  @ApiPropertyOptional({
    description:
      '`last_at` Toshkent kuni ≥ from (YYYY-MM-DD); from–to ≤ 366 kun',
    example: '2026-10-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({
    description: '`last_at` Toshkent kuni ≤ to (YYYY-MM-DD)',
    example: '2026-10-31',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    description: 'Sarlavha / obyekt nomi (ILIKE), ≤ 100',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: [...AI_ADVISOR_SORT_FIELDS],
    default: 'last_at',
  })
  @IsOptional()
  @IsIn([...AI_ADVISOR_SORT_FIELDS])
  sort_by?: (typeof AI_ADVISOR_SORT_FIELDS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_dir?: 'asc' | 'desc';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** `GET /ai/advisor/alerts/:id?include=history` (§5.2). */
export class AiAdvisorAlertGetQueryDto {
  @ApiPropertyOptional({
    enum: ['history'],
    description: '`history[]` (≤ 50) — faqat so‘ralganda',
  })
  @IsOptional()
  @IsIn(['history'])
  include?: 'history';
}

/**
 * `PATCH /ai/advisor/alerts/:id` (§7.5). `note` da uzunlik dekoratori YO'Q —
 * trim va 3–500 tekshiruvi ai-service'da → `AI_ADVISOR_NOTE_INVALID {reason}`.
 */
export class AiAdvisorAlertPatchDto {
  @ApiProperty({ enum: ['resolved', 'dismissed'] })
  @IsIn(['resolved', 'dismissed'])
  status!: 'resolved' | 'dismissed';

  @ApiPropertyOptional({
    description:
      "«Hal qilindi» — majburiy, trim'dan keyin 3–500 belgi; «Ahamiyatsiz» — ixtiyoriy, ≤ 500.",
    example: 'Kartadagi tushum keyingi kuni kelgan, tekshirildi.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  note?: string | null;
}
