import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Order_status, Where_deliver } from '@app/common';

enum OrderSourceDto {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  BRANCH = 'branch',
}

const parseFormattedNumber = (value: unknown): number | unknown => {
  if (value === undefined || value === null || value === '') {
    return value;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    return cleaned ? Number(cleaned) : value;
  }
  return value;
};

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
  @ApiPropertyOptional({
    example: '1',
    description: 'Market ID (admin/superadmin/reg uchun majburiy, market rolida token’dan olinadi)',
  })
  @IsOptional()
  @IsString()
  market_id?: string;

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
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status, default: Order_status.NEW })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
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

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '12', description: 'Branch ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  branch_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1001', description: 'Current batch ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  current_batch_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '77', description: 'Courier ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  courier_id?: string | null;

  @ApiPropertyOptional({ example: '2026-04-25T14:30:00+05:00' })
  @IsOptional()
  @IsISO8601()
  assigned_at?: string | null;

  @ApiPropertyOptional({ example: 'Mijoz uyda yo‘q edi' })
  @IsOptional()
  @IsString()
  return_reason?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiPropertyOptional({ enum: OrderSourceDto, default: OrderSourceDto.INTERNAL })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsOptional()
  @IsEnum(OrderSourceDto)
  source?: OrderSourceDto;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class UpdateOrderRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
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

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  region_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '12', description: 'Branch ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  branch_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1001', description: 'Current batch ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  current_batch_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '77', description: 'Courier ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  courier_id?: string | null;

  @ApiPropertyOptional({ example: '2026-04-25T14:30:00+05:00' })
  @IsOptional()
  @IsISO8601()
  assigned_at?: string | null;

  @ApiPropertyOptional({ example: 'Mijoz uyda yo‘q edi' })
  @IsOptional()
  @IsString()
  return_reason?: string | null;

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

export class UpdateOrderByIdRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsOptional()
  @IsEnum(Where_deliver)
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  total_price?: number;

  @ApiPropertyOptional({ enum: Order_status })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
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

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  post_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  district_id?: string | null;

  @ApiPropertyOptional({ type: String, example: '1' })
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

  @ApiPropertyOptional({ example: '1', description: 'Market ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  market_id?: string;

  @ApiPropertyOptional({ example: '1', description: 'Customer ID (as string/bigint)' })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  to_be_paid?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  paid_amount?: number;

  @ApiPropertyOptional({ example: 'qr_token' })
  @IsOptional()
  @IsString()
  qr_code_token?: string | null;

  @ApiPropertyOptional({ enum: OrderSourceDto, default: OrderSourceDto.INTERNAL })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsOptional()
  @IsEnum(OrderSourceDto)
  source?: OrderSourceDto;
}

export class OrdersArrayDto {
  @ApiProperty({
    type: [String],
    example: ['6b1f3f2a-8c1d-4e2b-9f4a-1234567890ab', '7c2e4d3b-9d2e-5f3c-0a5b-abcdefabcdef'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];
}

export class SellOrderRequestDto {
  @ApiPropertyOptional({ example: 'Customer accepted with discount' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ example: 5000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  extraCost?: number;

  @ApiPropertyOptional({ example: 20000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  paidAmount?: number;
}

export class PartlySoldItemDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsString()
  product_id!: string;

  @ApiProperty({ example: 1, minimum: 0 })
  @IsNumber()
  quantity!: number;
}

export class PartlySellOrderRequestDto {
  @ApiProperty({ type: [PartlySoldItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PartlySoldItemDto)
  order_item_info!: PartlySoldItemDto[];

  @ApiProperty({ example: 15000, minimum: 0 })
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  totalPrice!: number;

  @ApiPropertyOptional({ example: 2000, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => parseFormattedNumber(value))
  @IsNumber()
  extraCost?: number;

  @ApiPropertyOptional({ example: 'Customer bought only 1 unit' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CreateExternalOrderRequestDto extends CreateOrderRequestDto {
  @ApiPropertyOptional({ example: 'EXT-ORDER-1001' })
  @IsOptional()
  @IsString()
  external_id?: string | null;
}

export class ScanAssignOrderRequestDto {
  @ApiProperty({ example: 'ORD-abc123' })
  @IsNotEmpty()
  @IsString()
  qr_token!: string;
}

export class AssignOrdersToCourierRequestDto {
  @ApiProperty({
    type: [String],
    example: ['101', '102', '103'],
    description: 'Biriktiriladigan order IDlar',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];

  @ApiProperty({ example: '44', description: 'Courier user ID' })
  @IsNotEmpty()
  @IsString()
  courier_id!: string;
}
