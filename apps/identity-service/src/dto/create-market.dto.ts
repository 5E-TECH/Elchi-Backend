import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ExpenseProofCondition,
  Where_deliver,
} from '../../../../libs/common/enums';
import {
  IsPasswordPolicy,
  PASSWORD_MODES,
  Roles,
  type PasswordMode,
} from '@app/common';

export class CreateMarketDto {
  @ApiProperty({ example: 'Market 1' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: '+998901234567' })
  @IsNotEmpty()
  @IsPhoneNumber('UZ')
  phone_number: string;

  @ApiProperty({ example: 'market_01' })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  username: string;

  @ApiPropertyOptional({ example: 'Toshkent sh., Yunusobod tumani' })
  @IsOptional()
  @IsString()
  address?: string;

  /**
   * KmWO9gTA — market profil tariflari LEGACY: endi MAJBURIY EMAS (ustunlar
   * eski snapshotlar va audit uchun qoladi). Berilsa — standart uy/markaz
   * narxi (dvigatelning bazasi); berilmasa NULL (0 EMAS — 0 "bepul yetkazish"
   * degani) va sotuvda baza tarif jadvalidan olinadi (dvigatel yoqilganda).
   */
  @ApiPropertyOptional({
    example: 10000,
    minimum: 0,
    description:
      'Standart uy narxi (eski majburiy maydon; endi ixtiyoriy — berilmasa NULL)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number | null;

  @ApiPropertyOptional({
    example: 8000,
    minimum: 0,
    description:
      'Standart markaz narxi (eski majburiy maydon; endi ixtiyoriy — berilmasa NULL)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number | null;

  /**
   * KmWO9gTA — «Vazn va hajm bo'yicha narx» (sukut TRUE). Faqat
   * SUPERADMIN/ADMIN beradi (menejer — 403).
   */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  weight_volume_pricing?: boolean;

  @ApiProperty({
    example: Where_deliver.CENTER,
    enum: Where_deliver,
    description: 'Tariff type (center or address)',
  })
  @IsNotEmpty()
  @IsEnum(Where_deliver, {
    message: 'default_tariff must be either center or address',
  })
  default_tariff: Where_deliver;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  cancelled_handover_qr_required?: boolean;

  @ApiPropertyOptional({
    isArray: true,
    enum: ExpenseProofCondition,
    description:
      'Isbot (rasm/video) majburiy bo‘ladigan vaziyatlar to‘plami. Bo‘sh = isbot talab qilinmaydi.',
    example: [
      ExpenseProofCondition.CANCEL_EXTRA_COST,
      ExpenseProofCondition.CANCEL_ZERO_TOTAL,
    ],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ExpenseProofCondition, { each: true })
  expense_proof_conditions?: ExpenseProofCondition[];

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      "w2bDrE3i: market bo'yicha qo'shimcha xarajat ochiq/yopiq (faqat admin/superadmin). Sukut — yopiq.",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      "w2bDrE3i: TRUE — qo'shimcha xarajat market tasdig'idan o'tadi; FALSE — tasdiqsiz yoziladi (faqat admin/superadmin).",
  })
  @IsOptional()
  @IsBoolean()
  extra_cost_requires_approval?: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      "VRyloH62: TRUE — har buyurtmada operator raqami majburiy (default raqam yo'q bo'lsa formada).",
  })
  @IsOptional()
  @IsBoolean()
  require_operator_phone?: boolean;

  @ApiPropertyOptional({
    example: '+998901234567',
    nullable: true,
    description:
      "VRyloH62: marketning doimiy operator raqami — chekda 1-raqam. null/'' — o'chirish.",
  })
  @IsOptional()
  @IsString()
  default_operator_phone?: string | null;

  /**
   * (aidsxJ2H) Faqat `password_mode: 'manual'` (yoki rejimsiz eski so'rov).
   * `generate_sms` da yuborilmaydi — parolni identity o'zi yaratadi.
   */
  @ApiPropertyOptional({ example: 'Kuchli-Parol-2026' })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.MARKET)
  password?: string;

  /** (aidsxJ2H) `generate_sms` (sukut) | `manual` — `resolveCreatePassword`. */
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  /** (aidsxJ2H) Faqat `manual`: birinchi kirishda almashtirish majburiymi. */
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;
}
