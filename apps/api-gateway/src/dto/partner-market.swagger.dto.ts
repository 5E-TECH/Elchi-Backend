import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * `POST /partner/markets` — hamkor tomonidan sotuvchi uchun Elchi market
 * provisioning. Kontrakt: docs/PARTNER_API.md §3.2.
 */
export class CreatePartnerMarketRequestDto {
  @ApiProperty({
    description: 'Hamkor tomonidagi sotuvchi id (idempotency kaliti)',
  })
  @IsString()
  @IsNotEmpty()
  external_seller_id!: string;

  @ApiProperty({ example: 'Zamon Store' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiPropertyOptional({ description: 'Elchi region_id (yo‘nalish uchun)' })
  @IsOptional()
  @IsString()
  region_id?: string;

  @ApiPropertyOptional({ description: 'Elchi district_id (yo‘nalish uchun)' })
  @IsOptional()
  @IsString()
  district_id?: string;

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
