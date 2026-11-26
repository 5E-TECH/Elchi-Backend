import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Bitta fayldagi qatorlar chegarasi. Tana hajmi chegarasi shu songa moslangan
 * (`OLD_MAILS_BODY_LIMIT`, `order-export/old-mails-body-limit.ts`).
 */
export const OLD_MAILS_EXPORT_MAX_ROWS = 10_000;
/** Excel summasi aniq qolsin (10 000 × 10^11 < 2^53). */
const MAX_AMOUNT = 100_000_000_000;
const MAX_ORDERS = 1_000_000;

/** `info` — «Filial paketlari» dagi «Yangi» holati (FE `BATCH_STATUS_TONE`). */
export const OLD_MAILS_STATUS_TONES = [
  'success',
  'warning',
  'danger',
  'neutral',
  'info',
] as const;
export type OldMailsStatusTone = (typeof OLD_MAILS_STATUS_TONES)[number];

export class OldMailsExportRowDto {
  @ApiProperty({ example: '2417', maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  id!: string;

  @ApiProperty({ example: 'Andijon viloyati', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  region!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Jasur Tursunov',
    maxLength: 120,
    description: "Bo'sh / null — «—». `hide_courier` da e'tiborsiz.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier?: string | null;

  @ApiProperty({
    example: "Jo'natilgan",
    maxLength: 60,
    description: 'Tayyor yorliq (foydalanuvchi tilida)',
  })
  @IsString()
  @MaxLength(60)
  status!: string;

  @ApiPropertyOptional({
    enum: OLD_MAILS_STATUS_TONES,
    description: "Holat rangi; yo'q — rangsiz",
  })
  @IsOptional()
  @IsIn(OLD_MAILS_STATUS_TONES)
  status_tone?: OldMailsStatusTone | null;

  @ApiProperty({ example: 24, minimum: 0, maximum: MAX_ORDERS })
  @IsInt()
  @Min(0)
  @Max(MAX_ORDERS)
  orders!: number;

  @ApiProperty({
    example: 11310000,
    minimum: -MAX_AMOUNT,
    maximum: MAX_AMOUNT,
    description: "Summa, so'm (son)",
  })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(-MAX_AMOUNT)
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiProperty({
    example: '2026-11-21T12:32:00.000Z',
    maxLength: 40,
    description:
      "Pochta sanasi (ISO). Faylda Toshkent vaqti; o'qilmasa — matn, bo'sh — «—».",
  })
  @IsString()
  @MaxLength(40)
  created_at!: string;
}

/** Sukut yorliqlar (o'zbekcha) — `labels` da berilmagani shundan. */
export const OLD_MAILS_DEFAULT_LABELS = {
  generated_at: 'Yaratilgan vaqt',
  no: 'T/r',
  mail_id: 'Pochta raqami',
  region: 'Viloyat',
  courier: 'Kuryer',
  status: 'Holati',
  orders: 'Buyurtmalar',
  amount: 'Summa',
  date: 'Pochta sanasi',
  total_mails: 'Jami pochtalar',
  total_orders: 'Jami buyurtmalar',
  total_amount: 'Jami summa',
  currency: "so'm",
  summary_title: 'Eski pochtalar xulosasi',
  by_status: "Holatlar bo'yicha",
  by_region: "Viloyatlar bo'yicha",
  by_courier: "Kuryerlar bo'yicha",
  mails: 'Pochtalar',
  share: 'Ulushi',
  total: 'JAMI',
  others: 'Boshqalar',
  unassigned: 'Biriktirilmagan',
  mails_unit: 'ta pochta',
  orders_unit: 'ta buyurtma',
} as const;
type LabelKey = keyof typeof OLD_MAILS_DEFAULT_LABELS;

/** `hide_courier` («Filial paketlari») rejimidagi sukutlar. */
export const OLD_PACKETS_DEFAULT_LABELS: Partial<Record<LabelKey, string>> = {
  mail_id: 'Paket raqami',
  date: 'Paket sanasi',
  total_mails: 'Jami paketlar',
  summary_title: 'Eski paketlar xulosasi',
  mails: 'Paketlar',
  mails_unit: 'ta paket',
};

const Label = (key: LabelKey, maxLength = 80) =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      default: OLD_MAILS_DEFAULT_LABELS[key],
      maxLength,
    }),
    IsOptional(),
    IsString(),
    MaxLength(maxLength),
  );

/** Yorliqlar foydalanuvchi tilida; berilmagani — o'zbekcha sukut. */
export class OldMailsExportLabelsDto {
  @Label('generated_at')
  generated_at?: string;

  @Label('no')
  no?: string;

  @Label('mail_id')
  mail_id?: string;

  @Label('region')
  region?: string;

  @Label('courier')
  courier?: string;

  @Label('status')
  status?: string;

  @Label('orders')
  orders?: string;

  @Label('amount')
  amount?: string;

  @Label('date')
  date?: string;

  @Label('total_mails')
  total_mails?: string;

  @Label('total_orders')
  total_orders?: string;

  @Label('total_amount')
  total_amount?: string;

  @Label('currency', 20)
  currency?: string;

  @Label('summary_title', 120)
  summary_title?: string;

  @Label('by_status')
  by_status?: string;

  @Label('by_region')
  by_region?: string;

  @Label('by_courier')
  by_courier?: string;

  @Label('mails')
  mails?: string;

  @Label('share')
  share?: string;

  @Label('total', 20)
  total?: string;

  @Label('others')
  others?: string;

  @Label('unassigned')
  unassigned?: string;

  @Label('mails_unit', 20)
  mails_unit?: string;

  @Label('orders_unit', 20)
  orders_unit?: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      "`capped: true` dagi DIQQAT matni (sukut — o'zbekcha, qatorlar soni bilan)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  capped_note?: string;
}

export class OldMailsExportRequestDto {
  @ApiProperty({ example: 'Eski pochtalar hisoboti', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({
    example: 'Davr: 14.11.2026 – 21.11.2026 · Holat: barchasi',
    maxLength: 300,
    description: 'Banner osti matni (filtrlar)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subtitle?: string;

  @ApiPropertyOptional({
    description:
      "Ro'yxat chegaraga yetib kesilgan — faylda DIQQAT (tepada, oxirida va «Xulosa» da)",
  })
  @IsOptional()
  @IsBoolean()
  capped?: boolean;

  @ApiPropertyOptional({
    description: "«Filial paketlari» rejimi: kuryer ustuni va jadvali yo'q",
  })
  @IsOptional()
  @IsBoolean()
  hide_courier?: boolean;

  @ApiPropertyOptional({ type: OldMailsExportLabelsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OldMailsExportLabelsDto)
  labels?: OldMailsExportLabelsDto;

  @ApiProperty({
    type: [OldMailsExportRowDto],
    maxItems: OLD_MAILS_EXPORT_MAX_ROWS,
  })
  @IsArray()
  @ArrayMaxSize(OLD_MAILS_EXPORT_MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => OldMailsExportRowDto)
  rows!: OldMailsExportRowDto[];
}
