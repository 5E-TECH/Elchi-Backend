import { Status } from '@app/common';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

/** vpKijXce: users.id — musbat butun son (raqam yoki satr qabul qilinadi). */
const LINKED_USER_ID_RE = /^[1-9]\d{0,18}$/;
const toIdString = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? String(value) : value;

export class CreateInvestorDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiPropertyOptional({ enum: Status, default: Status.ACTIVE })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * vpKijXce: investor login qiladigan foydalanuvchi (users.id, rol =
   * investor). `GET /investors/me` investorni shu orqali topadi. Ilgari bu
   * maydon gateway'da yo'q edi (forbidNonWhitelisted → 400) — natijada hech
   * bir investor login bilan bog'lanmagan (user_id = '0').
   */
  @ApiPropertyOptional({ example: '25', description: 'users.id (investor)' })
  @IsOptional()
  @Transform(toIdString)
  @IsString()
  @Matches(LINKED_USER_ID_RE, { message: 'user_id must be a positive integer' })
  user_id?: string;
}

export class UpdateInvestorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ enum: Status })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  /** vpKijXce: login bilan bog'lash; `null` — bog'lanishni uzish. */
  @ApiPropertyOptional({
    example: '25',
    nullable: true,
    description: 'users.id (investor); null — uzish',
  })
  @IsOptional()
  @Transform(toIdString)
  @IsString()
  @Matches(LINKED_USER_ID_RE, { message: 'user_id must be a positive integer' })
  user_id?: string | null;
}

export class CreateInvestmentDto {
  @ApiProperty()
  @IsString()
  investor_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branch_id?: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: '2026-03-25T00:00:00.000Z' })
  @IsDateString()
  invested_at!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateInvestmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  investor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branch_id?: string;

  @ApiPropertyOptional({ minimum: 0.01 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ example: '2026-03-25T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  invested_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateProfitShareDto {
  @ApiProperty()
  @IsString()
  investor_id!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @ApiProperty({ example: '2026-03-01T00:00:00.000Z' })
  @IsDateString()
  period_start!: string;

  @ApiProperty({ example: '2026-03-31T23:59:59.999Z' })
  @IsDateString()
  period_end!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CalculateProfitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  investor_id?: string;

  @ApiProperty({ example: '2026-03-01T00:00:00.000Z' })
  @IsDateString()
  period_start!: string;

  @ApiProperty({ example: '2026-03-31T23:59:59.999Z' })
  @IsDateString()
  period_end!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * vpKijXce: ichki yo'llar (`POST /investors/:investor_id/investments|profits`)
 * — investor yo'ldan olinadi, body'da `investor_id` SHART EMAS. Berilsa yo'l
 * bilan bir xil bo'lishi kerak (aks holda 400, gateway `pathInvestorId`).
 */
export class CreateInvestorInvestmentDto extends OmitType(CreateInvestmentDto, [
  'investor_id',
] as const) {
  @ApiPropertyOptional({
    description: 'Berilsa yo‘ldagi investor_id bilan bir xil',
  })
  @IsOptional()
  @IsString()
  investor_id?: string;
}

export class CreateInvestorProfitShareDto extends OmitType(
  CreateProfitShareDto,
  ['investor_id'] as const,
) {
  @ApiPropertyOptional({
    description: 'Berilsa yo‘ldagi investor_id bilan bir xil',
  })
  @IsOptional()
  @IsString()
  investor_id?: string;
}

/**
 * vpKijXce: investor LOGINI (identity, rol = investor) — BeePost
 * `POST /users/investor` naqshi: faqat kirish uchun (ism, telefon, parol),
 * maosh/kassa yo'q. Keyin `POST/PATCH /investors {user_id}` bilan investor
 * yozuviga bog'lanadi va `/investors/me` shu orqali topadi.
 */
export class CreateInvestorUserRequestDto {
  @ApiProperty({ example: 'Investor Ismi' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'strongPassword123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;
}
