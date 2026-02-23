import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Order_status, Where_deliver } from '@app/common';

export class OrderItemDto {
  @ApiProperty({ example: '1', description: 'Product ID (as string/bigint)' })
  product_id!: string;

  @ApiPropertyOptional({ example: 1 })
  quantity?: number;
}

export class CreateOrderRequestDto {
  @ApiProperty({ example: '1', description: 'Market ID (as string/bigint)' })
  market_id!: string;

  @ApiProperty({ example: '1', description: 'Customer ID (as string/bigint)' })
  customer_id!: string;

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

  @ApiPropertyOptional({ example: 'Toshkent, Chilonzor' })
  address?: string | null;

  @ApiPropertyOptional({ example: 'qr_token' })
  qr_code_token?: string | null;

  @ApiPropertyOptional({ type: [OrderItemDto] })
  items?: OrderItemDto[];
}
