import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

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
