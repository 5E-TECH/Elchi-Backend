import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/** zRqDRLAZ: `numeric(14,2)` chegarasi (catalog-service bilan AYNI). */
const PRODUCT_PRICE_MAX = 999_999_999_999.99;

/**
 * zRqDRLAZ: narx multipart'da satr bo'lib keladi. Bo'sh satr / `null` —
 * narxni tozalash (`null`); raqamli satr — son; boshqa qiymat o'zgarishsiz
 * (keyin `IsNumber` uni 400 bilan rad etadi).
 */
const toPriceValue = ({ value }: { value: unknown }): unknown => {
  if (value === null) return null;
  if (typeof value === 'string') {
    const text = value.trim().replace(/\s+/g, '');
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
};

/** zRqDRLAZ: create va update DTO'larida umumiy narx maydoni. */
const PriceField = () =>
  applyDecorators(
    ApiPropertyOptional({
      example: 125000,
      nullable: true,
      minimum: 0,
      description:
        "Mahsulotning ma'lumotnoma narxi (so'm, ko'pi bilan 2 kasr). Ixtiyoriy; bo'sh satr yoki null — narxni tozalaydi. " +
        'Buyurtma summasiga avtomatik yozilmaydi — forma faqat taklif qiladi.',
    }),
    IsOptional(),
    Transform(toPriceValue),
    IsNumber(
      { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
      { message: "price — 0 dan katta yoki teng, ko'pi bilan 2 kasrli son" },
    ),
    Min(0, { message: "price manfiy bo'lishi mumkin emas" }),
    Max(PRODUCT_PRICE_MAX, { message: 'price juda katta' }),
  );

export class CreateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description:
      "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi.",
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ example: 'Pepsi' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product.png',
    description:
      'Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas.',
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Admin/Superadmin yuboradi. MARKET role uchun token sub ishlatiladi.',
  })
  @IsOptional()
  @IsString()
  market_id?: string;

  @PriceField()
  price?: number | null;
}

export class UpdateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description:
      "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi.",
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ example: 'Pepsi Max' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product-new.png',
    description:
      'Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas.',
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  @PriceField()
  price?: number | null;
}
