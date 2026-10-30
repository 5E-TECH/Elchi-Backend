import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

/**
 * T1 K1 (s6xY4f5C) — hamkor sotuvchisi ↔ mavjud Elchi marketi
 * (`/admin/partners/:id/markets`).
 */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Raqam yuborilsa ham qabul qilinadi (FE JSON'da son yuborishi mumkin). */
const digitsToString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : value;

export class LinkPartnerMarketRequestDto {
  @ApiProperty({
    example: 'shop-9',
    description: 'Hamkor tomonidagi sotuvchi id (trim, 1..100 belgi)',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  external_seller_id!: string;

  @ApiProperty({
    example: '1234',
    description: 'Elchi’dagi MAVJUD market id’si (faqat raqam)',
  })
  @Transform(digitsToString)
  @IsString()
  @Matches(/^\d{1,18}$/, { message: 'elchi_market_id faqat raqam' })
  elchi_market_id!: string;
}

export class PartnerMarketLinkDto {
  @ApiProperty({ example: '12' })
  ref_id!: string;

  @ApiProperty({ example: 'shop-9' })
  external_seller_id!: string;

  @ApiProperty({ example: '1234' })
  elchi_market_id!: string;

  @ApiProperty({ type: Number, nullable: true, example: 30000 })
  tariff_home!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 20000 })
  tariff_center!: number | null;
}

export class PartnerMarketRowDto extends PartnerMarketLinkDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Market topilmasa (o‘chirilgan) — null',
  })
  market_name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone_number!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at!: string;
}

export class PartnerMarketListResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'partner markets' })
  message!: string;

  @ApiProperty({ type: [PartnerMarketRowDto] })
  data!: PartnerMarketRowDto[];
}

export class PartnerMarketLinkResponseDto {
  @ApiProperty({ example: 201 })
  statusCode!: number;

  @ApiProperty({ example: 'partner market linked' })
  message!: string;

  @ApiProperty({ type: PartnerMarketLinkDto })
  data!: PartnerMarketLinkDto;
}
