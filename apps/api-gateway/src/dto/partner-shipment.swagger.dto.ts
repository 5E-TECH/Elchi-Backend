import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ShipmentCustomerDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @IsNotEmpty()
  phone!: string;
}

export class ShipmentItemDto {
  @ApiProperty({ example: 'Kitob' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 2, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  /**
   * Hamkor tizimidagi mahsulot id.
   *
   * Berilsa, Elchi shu id bo'yicha katalogdan mahsulotni topadi — yo'q bo'lsa
   * AVTOMATIK yaratadi, bor bo'lsa qayta ishlatadi. Shu orqali hamkor
   * mahsulotlari hisobot va qidiruvda ko'rinadi.
   *
   * NOM bo'yicha bog'lanmaydi: nom o'zgaruvchan, va nom bo'yicha bog'lansa
   * hamkor nomni tuzatgan zahoti katalogda dublikat paydo bo'lardi.
   *
   * Berilmasa, eski xulq saqlanadi: nom faqat matn bo'lib yoziladi.
   */
  @ApiPropertyOptional({
    description:
      'Hamkor tizimidagi mahsulot id — katalog bog‘lanishi shu bo‘yicha (nom bo‘yicha emas)',
    example: 'a3f1c8e2-7b44-4d91-9f02-1c5e6d8a4b30',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  external_product_id?: string;
}

/** `POST /partner/shipments` — kontrakt: docs/PARTNER_API.md §3.3. */
export class CreatePartnerShipmentRequestDto {
  @ApiProperty({ description: 'Marketplace buyurtma id (idempotency kaliti)' })
  @IsString()
  @IsNotEmpty()
  external_order_id!: string;

  @ApiProperty({ description: 'Sotuvchining Elchi market id (§3.2)' })
  @IsString()
  @IsNotEmpty()
  elchi_market_id!: string;

  @ApiProperty({ type: ShipmentCustomerDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ShipmentCustomerDto)
  customer!: ShipmentCustomerDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region_id?: string;

  @ApiProperty({ description: 'Tuman id (customer uchun majburiy)' })
  @IsString()
  @IsNotEmpty()
  district_id!: string;

  @ApiPropertyOptional({ enum: ['center', 'address'], default: 'center' })
  @IsOptional()
  @IsIn(['center', 'address'])
  where_deliver?: string;

  @ApiPropertyOptional({ type: [ShipmentItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items?: ShipmentItemDto[];

  @ApiProperty({
    example: 0,
    description: '0 = prepaid (online), >0 = COD (kuryer yig‘adi)',
  })
  @IsNumber()
  @Min(0)
  cod_amount!: number;

  @ApiPropertyOptional({ description: 'Buyurtma qiymati (total_price uchun)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  subtotal?: number;

  @ApiPropertyOptional({
    example: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    description:
      "Hamkor YORLIG'IDAGI QR qiymati. Berilsa Elchi shu tokenni buyurtmaga " +
      "yozadi va posilkani skanerlash ishlaydi. Berilmasa Elchi o'z tokenini " +
      "yaratadi va hamkor yorlig'i skanerda TOPILMAYDI.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/, {
    message:
      'label_token 8-128 belgidan iborat bo‘lishi va faqat harf/raqam/_/- ' +
      'saqlashi kerak',
  })
  label_token?: string;

  /**
   * KIRUVCHI QOP (batch) — bitta qopda ketayotgan posilkalar guruhi.
   *
   * ⚠️ BU MAYDONLAR SHU YERDA E'LON QILINISHI SHART. Gateway
   * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` bilan
   * ishlaydi — DTO da yo'q maydon 400 bilan RAD ETILADI. Men aynan shu
   * tuzoqqa tushdim: maydonlarni ichki servis tipiga qo'shdim-u DTO ga
   * qo'shmadim, va butun jo'natish yo'li "property batch_ref should not
   * exist" bilan yiqildi.
   *
   * `batch_label_token` — QOP USTIDAGI QR. Elchi operatori uni bitta marta
   * skanerlaganda qopdagi BARCHA posilka qabul qilinadi.
   */
  @ApiPropertyOptional({
    description:
      "Hamkor tomonidagi qop/pochta id'si — kiruvchi ekranda guruhlash uchun.",
    example: 'post-77',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  batch_ref?: string;

  @ApiPropertyOptional({
    description:
      'QOP USTIDAGI QR token. Elchi operatori bitta skan bilan butun qopni ' +
      'qabul qiladi. Formati `label_token` bilan bir xil.',
    example: 'BAG-2026-0915-77',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/, {
    message:
      'batch_label_token 8-128 belgidan iborat bo‘lishi va faqat ' +
      'harf/raqam/_/- saqlashi kerak',
  })
  batch_label_token?: string;

  @ApiPropertyOptional({
    description:
      'Shu qopda ketayotgan posilka soni — HAMKOR aytgan son. Elchi uni ' +
      'o‘zi sanagan son bilan solishtiradi (qop to‘liq yetib keldimi).',
    example: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  batch_size?: number;
}
