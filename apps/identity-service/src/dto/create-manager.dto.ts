import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  IsPasswordPolicy,
  PASSWORD_MODES,
  Roles,
  type PasswordMode,
} from '@app/common';

export class CreateManagerDto {
  @ApiProperty({ example: 'Branch manager' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: '+998901234567' })
  @IsNotEmpty()
  @IsPhoneNumber('UZ')
  phone_number: string;

  /**
   * (aidsxJ2H) Faqat `password_mode: 'manual'` (yoki rejimsiz eski so'rov).
   * `generate_sms` da yuborilmaydi — parolni identity o'zi yaratadi.
   */
  @ApiPropertyOptional({ example: 'Kuchli-Parol-2026' })
  @IsOptional()
  @IsString()
  @IsPasswordPolicy(Roles.MANAGER)
  password?: string;

  /** (aidsxJ2H) `generate_sms` (sukut) | `manual` — `resolveCreatePassword`. */
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  /** (aidsxJ2H) Faqat `manual`: birinchi kirishda almashtirish majburiymi. */
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

  @ApiPropertyOptional({ example: 3000000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiPropertyOptional({
    example: 10,
    minimum: 1,
    maximum: 30,
    description: 'Payment day of month',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiProperty({
    example: '1',
    description: 'Branch ID (gateway assignment uchun)',
  })
  @IsNotEmpty()
  @IsString()
  branch_id: string;

  @ApiPropertyOptional({ example: 10000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;
}
