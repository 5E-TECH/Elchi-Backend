import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
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
 * Aniq kalendar kuni (`YYYY-MM-DD`, aylanmaydi: 2026-02-30 → 400, yil ≥ 2000)
 * — ai-service `isDay` bilan bir xil (round-2 #654 S1).
 */
@ValidatorConstraint({ name: 'calendarDay', async: false })
export class CalendarDayConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      return false;
    const d = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(d.getTime()) &&
      d.getUTCFullYear() >= 2000 &&
      d.toISOString().slice(0, 10) === value
    );
  }

  defaultMessage(): string {
    return "sana noto'g'ri (YYYY-MM-DD)";
  }
}

/** C0 boshqaruv belgilari (\n, \t dan tashqari) va DEL yo'q. */
// eslint-disable-next-line no-control-regex -- ataylab: boshqaruv belgilarini rad etish
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

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
  @Validate(CalendarDayConstraint)
  from?: string;

  @ApiPropertyOptional({
    description: '`last_at` Toshkent kuni ≤ to (YYYY-MM-DD)',
    example: '2026-10-31',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @Validate(CalendarDayConstraint)
  to?: string;

  @ApiPropertyOptional({
    description: 'Sarlavha / obyekt nomi (ILIKE), ≤ 100',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(NO_CONTROL_CHARS)
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

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 1_000_000,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
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
    type: String,
    description:
      "«Hal qilindi» — majburiy, trim'dan keyin 3–500 belgi; «Ahamiyatsiz» — ixtiyoriy, ≤ 500. Boshqaruv belgilari (\\n, \\t dan tashqari) — 400.",
    example: 'Kartadagi tushum keyingi kuni kelgan, tekshirildi.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(NO_CONTROL_CHARS)
  note?: string | null;
}
