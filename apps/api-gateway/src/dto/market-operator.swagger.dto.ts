import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
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
 * POST /market-operators (i76gGjyq). `market_id` va `role` ATAYLAB yo'q:
 * market — JWT `sub`, rol — doim `market_operator`. Global ValidationPipe
 * (forbidNonWhitelisted) tanada `market_id`/`role` kelsa 400 qaytaradi.
 */
export class CreateMarketOperatorRequestDto {
  @ApiProperty({ example: 'Ali Valiyev', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'secret123', minLength: 4 })
  @IsString()
  @MinLength(4)
  password!: string;
}

/**
 * PATCH /market-operators/:id/commission (i76gGjyq). Hech bo'lmasa bitta
 * maydon; `null` — tozalash. Turi bo'yicha aniq chegara identity'da:
 * percent 0..100, fixed 0..1 000 000 so'm.
 */
export class UpdateMarketOperatorCommissionRequestDto {
  @ApiPropertyOptional({
    enum: Commission_type,
    nullable: true,
    example: Commission_type.PERCENT,
    description:
      "percent — buyurtma total_price foizi; fixed — sotilgan buyurtma uchun so'm; null — komissiya yo'q",
  })
  @IsOptional()
  @IsEnum(Commission_type)
  commission_type?: Commission_type | null;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    minimum: 0,
    maximum: 1_000_000,
    description: "Foiz (0..100) yoki so'm (0..1 000 000), ko'pi bilan 2 kasr",
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  commission_value?: number | null;
}
