import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Status, Where_deliver } from '@app/common';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @IsOptional()
  @IsPhoneNumber('UZ')
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
  salary?: number;

  @IsOptional()
  @IsNumber()
  payment_day?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @IsOptional()
  @IsEnum(Where_deliver)
  default_tariff?: Where_deliver;

  @IsOptional()
  @IsString()
  region_id?: string;
}
