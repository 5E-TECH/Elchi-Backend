import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Order_status, Where_deliver } from '@app/common';

export class OrderItemDto {
  @ApiProperty({ example: '1', description: 'Product ID (as string/bigint)' })
  product_id!: string;

  @ApiPropertyOptional({ example: 1 })
  quantity?: number;
}

export class CreateOrderCustomerDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  name!: string;

  @ApiProperty({ example: '+998901112233' })
  phone_number!: string;

  @ApiPropertyOptional({ example: '1' })
  market_id?: string;

  @ApiProperty({ example: '12' })
  district_id!: string;

  @ApiPropertyOptional({ example: '90-111-22-33' })
  extra_number?: string;

  @ApiPropertyOptional({ example: 'Yunusobod, 12-kvartal' })
  address?: string;
}

export class CreateOrderRequestDto {
  @ApiProperty({ example: '1', description: 'Market ID (as string/bigint)' })
  market_id!: string;

  @ApiPropertyOptional({ example: '1', description: 'Customer ID (as string/bigint)' })
  customer_id?: string;

  @ApiPropertyOptional({ type: CreateOrderCustomerDto })
  customer?: CreateOrderCustomerDto;

  @ApiPropertyOptional({ enum: Where_deliver, default: Where_deliver.CENTER })
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  total_price?: number;

  @ApiPropertyOptional({ example: 0 })
  to_be_paid?: number;

  @ApiPropertyOptional({ example: 0 })
  paid_amount?: number;

  @ApiPropertyOptional({ enum: Order_status, default: Order_status.NEW })
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  operator?: string | null;

  @ApiPropertyOptional({ example: '1' })
  post_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  district_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  address?: string | null;

  @ApiPropertyOptional({ example: 'qr_token' })
  qr_code_token?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  items?: OrderItemDto[];
}

export class UpdateOrderRequestDto {
  @ApiPropertyOptional({ enum: Where_deliver })
  where_deliver?: Where_deliver;

  @ApiPropertyOptional({ example: 0 })
  total_price?: number;

  @ApiPropertyOptional({ example: 0 })
  to_be_paid?: number;

  @ApiPropertyOptional({ example: 0 })
  paid_amount?: number;

  @ApiPropertyOptional({ enum: Order_status })
  status?: Order_status;

  @ApiPropertyOptional({ example: 'Izoh' })
  comment?: string | null;

  @ApiPropertyOptional({ example: 'Operator' })
  operator?: string | null;

  @ApiPropertyOptional({ example: '1' })
  post_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  district_id?: string | null;

  @ApiPropertyOptional({ example: '1' })
  region_id?: string | null;

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  address?: string | null;

  @ApiPropertyOptional({ example: 'qr_token' })
  qr_code_token?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  items?: OrderItemDto[];
}
