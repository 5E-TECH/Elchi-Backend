import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Commission_type, Status, IsPasswordPolicy, Roles } from '@app/common';

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

  @ApiProperty({
    example: 'Kuchli-Parol-2026',
    minLength: 8,
    description: 'Kamida 8 belgi (xodim — 10), oddiy parollar taqiqlangan',
  })
  @IsString()
  @IsPasswordPolicy(Roles.MARKET_OPERATOR)
  password!: string;

  // B3ZtzCCx (ega qarori 2026-10-19, MO-S5): ixtiyoriy komissiya — AYNI
  // so'rovda, atomik. Cheklovlar PATCH :id/commission bilan bir xil;
  // ikkalasi BIRGA (faqat bittasi — 400, identity tekshiradi).
  @ApiPropertyOptional({
    enum: Commission_type,
    nullable: true,
    example: Commission_type.PERCENT,
    description:
      "Ixtiyoriy. percent — buyurtma total_price foizi; fixed — sotilgan buyurtma uchun so'm. `commission_value` bilan BIRGA yuboriladi (faqat bittasi — 400); ikkalasi yo'q yoki null — komissiyasiz",
  })
  @IsOptional()
  @IsEnum(Commission_type)
  commission_type?: Commission_type | null;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    minimum: 0,
    maximum: 1_000_000,
    description:
      "Ixtiyoriy. Foiz (0..100) yoki so'm (0..1 000 000), ko'pi bilan 2 kasr. `commission_type` bilan BIRGA",
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  commission_value?: number | null;
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

/**
 * PATCH /market-operators/:id/warehouse-access (XtcEyQjb). Market o'z
 * operatoriga «Ombordagi qoldiq»ni ochadi (`true`) yoki yopadi (`false`).
 */
export class UpdateMarketOperatorWarehouseAccessRequestDto {
  @ApiProperty({
    example: true,
    description:
      "true — operator `GET /market/warehouse-stock` ni ko'radi; false — 403 `WAREHOUSE_STOCK_FORBIDDEN`",
  })
  @IsBoolean()
  can_view_warehouse_stock!: boolean;
}

/**
 * PATCH /market-operators/:id/status (mFkrqvMi). Market o'z operatorini
 * nofaol qiladi (`inactive` — barcha sessiyalari yopiladi) yoki qayta faol
 * qiladi (`active`). Buyurtmalar, komissiya va daromad tarixi saqlanadi.
 */
export class UpdateMarketOperatorStatusRequestDto {
  @ApiProperty({
    enum: [Status.ACTIVE, Status.INACTIVE],
    example: Status.INACTIVE,
    description:
      "inactive — operator tizimga kira olmaydi, sessiyalari yopiladi (qurilma keyingi refresh'da chiqariladi); active — qayta faol",
  })
  @IsIn([Status.ACTIVE, Status.INACTIVE])
  status!: Status;
}
