import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Status, Where_deliver } from '@app/common';

export class UpdateMarketDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  password?: string;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @IsOptional()
  @IsEnum(Where_deliver)
  default_tariff?: Where_deliver;

  @IsOptional()
  @IsBoolean()
  add_order?: boolean;
}
