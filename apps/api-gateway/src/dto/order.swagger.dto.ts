import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Order_status, Where_deliver } from '@app/common';

export class OrderItemDto {
  @ApiProperty({ example: '1', description: 'Product ID (as string/bigint)' })
  @IsNotEmpty()
  @IsString()
  product_id!: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  quantity?: number;
}

export class CreateOrderCustomerDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+998901112233' })
  @IsNotEmpty()
  @IsString()
  phone_number!: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiProperty({ example: '12' })
  @IsNotEmpty()
  @IsString()
  district_id!: string;

  @ApiPropertyOptional({ example: '90-111-22-33' })
  @IsOptional()
  @IsString()
  extra_number?: string;

  @ApiPropertyOptional({ example: 'Yunusobod, 12-kvartal' })
  @IsOptional()
  @IsString()
  address?: string;
}

export class CreateOrderRequestDto {
  @ApiProperty({ example: '1', description: 'Market ID (as string/bigint)' })
  @IsNotEmpty()
  @IsString()
  market_id!: string;

  @ApiPropertyOptional({ example: '1', description: 'Customer ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ type: CreateOrderCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateOrderCustomerDto)
  customer?: CreateOrderCustomerDto;

  @ApiPropertyOptional({ enum: Where_deliver, default: Where_deliver.CENTER })
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status, default: Order_status.NEW })
  @IsOptional()
  @IsEnum(Order_status)
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class UpdateOrderRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status })
  @IsOptional()
  @IsEnum(Order_status)
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  @IsOptional()
  @IsString()
  operator?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}
