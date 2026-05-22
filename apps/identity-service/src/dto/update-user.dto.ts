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
import { Commission_type, Status, Where_deliver } from '@app/common';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

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

  // Operator commission config. Used by finance-service to compute per-order
  // earnings when an order created by this operator is sold.
  @IsOptional()
  @IsEnum(Commission_type)
  commission_type?: Commission_type;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commission_value?: number;
}
