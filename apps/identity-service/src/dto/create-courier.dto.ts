import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsPasswordPolicy,
  PASSWORD_MODES,
  Roles,
  type PasswordMode,
} from '@app/common';

export class CreateCourierDto {
  @ApiProperty({
    description: 'Region ID',
    example: '1',
  })
  @IsNotEmpty()
  @IsString()
  region_id: string;

  @ApiProperty({ example: 'Akmal Abdullaev' })
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
  @IsPasswordPolicy(Roles.COURIER)
  password?: string;

  /** (aidsxJ2H) `generate_sms` (sukut) | `manual` — `resolveCreatePassword`. */
  @IsOptional()
  @IsIn(PASSWORD_MODES)
  password_mode?: PasswordMode;

  /** (aidsxJ2H) Faqat `manual`: birinchi kirishda almashtirish majburiymi. */
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;

  @ApiPropertyOptional({
    example: 2000000,
    minimum: 0,
    description: 'Optional, default is 0',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiProperty({
    example: 10,
    minimum: 1,
    maximum: 30,
    required: false,
    description: 'Payment day of month',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiPropertyOptional({
    example: 10000,
    minimum: 0,
    description: 'Optional, default is 0',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({
    example: 8000,
    minimum: 0,
    description: 'Optional, default is 0',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Branch ID. When set, identity-service will assign the new courier to this branch as part of the create flow.',
  })
  @IsOptional()
  @IsString()
  branch_id?: string;

  /**
   * DtKKY0V8 — kuryer tumani: mavjud va kuryer viloyatiga (`region_id`)
   * tegishli bo'lishi kerak (servis tekshiradi); berilmasa / null — tumansiz.
   */
  @ApiPropertyOptional({ example: '41', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: "district_id raqamli ID bo'lishi kerak" })
  district_id?: string | null;
}
