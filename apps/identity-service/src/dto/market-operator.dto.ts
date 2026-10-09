import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Commission_type } from '@app/common';

/**
 * Market O'ZI yaratadigan operator (i76gGjyq). `market_id` va `role` bu yerda
 * YO'Q — ular so'rovchidan (gateway: JWT `sub`) olinadi, mijozga ishonilmaydi.
 */
export class CreateMarketOperatorDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsNotEmpty()
  @IsPhoneNumber('UZ')
  phone_number: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(4)
  password: string;
}

/**
 * Operator komissiyasi (i76gGjyq). `null` — tozalash (operator komissiya
 * olmaydi). Turi bo'yicha aniq chegara servisda: PERCENT 0..100,
 * FIXED 0..1 000 000 so'm.
 */
export class UpdateMarketOperatorCommissionDto {
  @IsOptional()
  @IsEnum(Commission_type)
  commission_type?: Commission_type | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  commission_value?: number | null;
}
