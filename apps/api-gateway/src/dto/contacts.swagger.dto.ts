import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { RESPONSIBLE_BULK_MAX } from '@app/common';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — so'rov/javob DTO'lari.
 *
 * `support_phones` tarkibi bu yerda TEKSHIRILMAYDI (`@Allow`): format,
 * takror va soni identity'da — xato `SUPPORT_PHONES_INVALID` kodi bilan
 * qaytishi uchun (DTO xatosi kodsiz bo'lardi).
 */
const BIGINT_ID = /^\d{1,19}$/;

export class UpdateContactSettingsRequestDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['+998712001122'],
    description:
      "Zaxira raqamlar (0–2 ta). `+998XXXXXXXXX` ga normallanadi, takrorsiz. Noto'g'ri / 3 ta → 400 `SUPPORT_PHONES_INVALID`. `[]` — tozalash.",
  })
  @Allow()
  support_phones?: unknown;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '15',
    description:
      "Sukut market mas'uli (superadmin/admin/registrator/logist). null — sukutsiz. Xodim yo'q → 404; rol mos emas → 400 `RESPONSIBLE_ROLE_INVALID`; nofaol → 400 `RESPONSIBLE_INACTIVE`.",
  })
  @IsOptional()
  @IsString()
  @Matches(BIGINT_ID, {
    message: 'default_market_responsible_id — xodim id si',
  })
  default_market_responsible_id?: string | null;
}

export class MarketResponsibleBulkRequestDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '15',
    description: "Yangi mas'ul. `null` — marketlar sukutga qaytadi.",
  })
  @ValidateIf(
    (dto: MarketResponsibleBulkRequestDto) => dto.responsible_id !== null,
  )
  @IsString()
  @Matches(BIGINT_ID, { message: 'responsible_id — xodim id si yoki null' })
  responsible_id!: string | null;

  @ApiProperty({
    type: [String],
    example: ['101', '102', '103'],
    description: `Market id lari (1–${RESPONSIBLE_BULK_MAX}). Market bo'lmagan id → 400 \`NOT_A_MARKET\` (hech narsa o'zgarmaydi).`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RESPONSIBLE_BULK_MAX)
  @IsString({ each: true })
  @Matches(BIGINT_ID, { each: true, message: 'market_ids — market id lari' })
  market_ids!: string[];
}

export class SetMarketResponsibleRequestDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '15',
    description: "Mas'ul. `null` — sukutga qaytarish.",
  })
  @ValidateIf(
    (dto: SetMarketResponsibleRequestDto) => dto.responsible_id !== null,
  )
  @IsString()
  @Matches(BIGINT_ID, { message: 'responsible_id — xodim id si yoki null' })
  responsible_id!: string | null;
}

export class ResponsibleSummaryDto {
  @ApiProperty({ example: '15' }) id!: string;
  @ApiProperty({ example: 'Dilnoza Karimova' }) name!: string;
  @ApiProperty({ example: '+998901112233' }) phone_number!: string;
  @ApiProperty({
    example: 'registrator',
    enum: ['superadmin', 'admin', 'registrator', 'logist'],
  })
  role!: string;
}

export class ResponsibleWithStatusDto extends ResponsibleSummaryDto {
  @ApiProperty({ example: 'active', enum: ['active', 'inactive'] })
  status!: string;
}

export class ContactSettingsResponseDto {
  @ApiProperty({ type: [String], example: ['+998712001122'] })
  support_phones!: string[];

  @ApiProperty({ type: ResponsibleWithStatusDto, nullable: true })
  default_market_responsible!: ResponsibleWithStatusDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-30T09:00:00.000Z',
  })
  updated_at!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1' })
  updated_by!: string | null;
}

export class ResponsibleCandidateDto extends ResponsibleWithStatusDto {
  @ApiProperty({
    example: 12,
    description: 'Shu xodimga biriktirilgan marketlar soni',
  })
  market_count!: number;
}

export class ResponsiblesResponseDto {
  @ApiProperty({ type: [ResponsibleCandidateDto] })
  candidates!: ResponsibleCandidateDto[];

  @ApiProperty({ type: String, nullable: true, example: '15' })
  default_responsible_id!: string | null;

  @ApiProperty({
    example: 40,
    description: 'Sukutdagi (biriktirilmagan) marketlar soni',
  })
  default_market_count!: number;
}

export class MovedFromDto {
  @ApiProperty({ example: '15' }) responsible_id!: string;
  @ApiProperty({ example: 2 }) count!: number;
}

export class MarketResponsibleBulkResponseDto {
  @ApiProperty({
    example: 3,
    description: "Mas'uli haqiqatan o'zgargan marketlar",
  })
  updated!: number;

  @ApiProperty({
    type: [MovedFromDto],
    description: "Boshqa mas'uldan ko'chganlar (sukutdan ko'chganlar kirmaydi)",
  })
  moved_from!: MovedFromDto[];
}

export class MarketResponsibleResponseDto {
  @ApiProperty({ example: '101' }) id!: string;

  @ApiProperty({ type: ResponsibleSummaryDto, nullable: true })
  responsible!: ResponsibleSummaryDto | null;

  @ApiProperty({ enum: ['assigned', 'default', 'none'] })
  responsible_source!: 'assigned' | 'default' | 'none';
}

export class MyContactRegionDto {
  @ApiProperty({ example: '3' }) id!: string;
  @ApiProperty({ example: 'Andijon viloyati' }) name!: string;
}

export class MyContactDto {
  @ApiProperty({ type: String, nullable: true, example: '15' })
  user_id!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Aziz Logist' })
  name!: string | null;
  @ApiProperty({ example: '+998901112233' }) phone!: string;
  @ApiProperty({ type: String, nullable: true, example: 'logist' })
  role!: string | null;
}

export class MyContactsResponseDto {
  @ApiProperty({ enum: ['market_responsible', 'region_logist', 'none'] })
  kind!: 'market_responsible' | 'region_logist' | 'none';

  @ApiProperty({
    enum: ['assigned', 'default', 'support'],
    nullable: true,
    description: "`null` — raqam yo'q (`contacts: []`) yoki `kind: none`",
  })
  source!: 'assigned' | 'default' | 'support' | null;

  @ApiProperty({ type: [MyContactRegionDto] })
  regions!: MyContactRegionDto[];

  @ApiProperty({ type: [MyContactDto] })
  contacts!: MyContactDto[];
}

export class ProblemContactDto {
  @ApiProperty({ type: String, nullable: true, example: 'Aziz Logist' })
  name!: string | null;
  @ApiProperty({ example: '+998901112233' }) phone!: string;
  @ApiProperty({ enum: ['logist', 'support'] }) source!: 'logist' | 'support';
}

// ---- Javob konvertlari (`{ statusCode, message, data }`) ----

export class ContactSettingsEnvelopeDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: ContactSettingsResponseDto })
  data!: ContactSettingsResponseDto;
}

export class ResponsiblesEnvelopeDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: ResponsiblesResponseDto })
  data!: ResponsiblesResponseDto;
}

export class MarketResponsibleBulkEnvelopeDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: "Market mas'ullari yangilandi" }) message!: string;
  @ApiProperty({ type: MarketResponsibleBulkResponseDto })
  data!: MarketResponsibleBulkResponseDto;
}

export class MarketResponsibleEnvelopeDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: "Market mas'uli yangilandi" }) message!: string;
  @ApiProperty({ type: MarketResponsibleResponseDto })
  data!: MarketResponsibleResponseDto;
}

export class MyContactsEnvelopeDto {
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: 'success' }) message!: string;
  @ApiProperty({ type: MyContactsResponseDto }) data!: MyContactsResponseDto;
}
