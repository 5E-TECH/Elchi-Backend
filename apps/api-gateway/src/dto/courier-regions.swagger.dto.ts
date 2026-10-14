import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** hEjjuJaT — super-kuryerning bitta viloyati (ixtiyoriy alohida tarif). */
export class CourierRegionItemDto {
  @ApiProperty({ example: '5', description: 'Viloyat ID (bigint string)' })
  @IsNumberString()
  region_id!: string;

  @ApiPropertyOptional({
    example: 15000,
    nullable: true,
    description:
      'Uyga yetkazish tarifi; null — kuryerning umumiy tarifiga fallback',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  tariff_home?: number | null;

  @ApiPropertyOptional({
    example: 12000,
    nullable: true,
    description: 'Markazga yetkazish tarifi; null — umumiy tarifga fallback',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  tariff_center?: number | null;
}

/**
 * hEjjuJaT — PUT /couriers/:id/regions: ro'yxat TO'LIQ almashtiriladi.
 * is_super_courier=false → viloyatlar tozalanadi (oddiy kuryer).
 */
export class SetCourierRegionsRequestDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_super_courier?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "TRUE — courier_regions'dan qat'i nazar HAR BIR viloyat pochtasida chiqadi (faqat super-kuryer)",
  })
  @IsOptional()
  @IsBoolean()
  serves_all_regions?: boolean;

  @ApiPropertyOptional({ type: [CourierRegionItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CourierRegionItemDto)
  regions?: CourierRegionItemDto[];
}
