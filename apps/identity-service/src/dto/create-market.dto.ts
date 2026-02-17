import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Where_deliver } from '../../../../libs/common/enums';

export class CreateMarketDto {
  @ApiProperty({ example: 'Market 1' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: '+998901234567' })
  @IsNotEmpty()
  @IsString()
  phone_number: string;

  @ApiPropertyOptional({ example: 'market_01' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @ApiProperty({ example: 10000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  tariff_home: number;

  @ApiProperty({ example: 8000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  tariff_center: number;

  @ApiProperty({
    example: Where_deliver.CENTER,
    enum: Where_deliver,
    description: 'Tariff type (center or address)',
  })
  @IsNotEmpty()
  @IsEnum(Where_deliver, {
    message: 'default_tariff must be either center or address',
  })
  default_tariff: Where_deliver;

  @ApiProperty({ example: false })
  @IsBoolean()
  add_order: boolean;

  @ApiProperty({ example: 'secret123' })
  @IsNotEmpty()
  @IsString()
  @MinLength(4)
  password: string;
}
