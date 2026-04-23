import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';

export class CreateCashboxRequestDto {
  @ApiProperty({ example: '12345' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiProperty({ enum: Cashbox_type, example: Cashbox_type.FOR_COURIER })
  @IsEnum(Cashbox_type)
  cashbox_type!: Cashbox_type;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance_cash?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  balance_card?: number;
}

export class FindCashboxByUserQueryDto {
  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  with_history?: boolean;

  @ApiPropertyOptional({ example: 1, description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  page?: number;

  @ApiPropertyOptional({ example: 20, description: '0 yuborilsa pagination o‘chadi va hamma history qaytadi' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limit?: number;
}

export class UpdateCashboxBalanceRequestDto {
  @ApiPropertyOptional({ example: '1001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @ApiProperty({ example: 150000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: Operation_type, example: Operation_type.INCOME })
  @IsEnum(Operation_type)
  operation_type!: Operation_type;

  @ApiProperty({ enum: Source_type, example: Source_type.COURIER_PAYMENT })
  @IsEnum(Source_type)
  source_type!: Source_type;

  @ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @ApiPropertyOptional({ example: 'Izoh' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ example: '999' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @ApiPropertyOptional({ example: '777' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string;

  @ApiPropertyOptional({ example: '555' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

  @ApiPropertyOptional({ example: '2026-03-06T11:00:00Z' })
  @IsOptional()
  payment_date?: string;
}

export class FindHistoryQueryDto {
  @ApiPropertyOptional({ example: '1001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @ApiPropertyOptional({ enum: Operation_type })
  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @ApiPropertyOptional({ enum: Source_type })
  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @ApiPropertyOptional({ example: '999' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  to_date?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class OpenShiftRequestDto {
  @ApiProperty({ example: '15' })
  @IsString()
  @Matches(/^\d+$/)
  opened_by!: string;

  @ApiPropertyOptional({ example: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  opening_balance_cash?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  opening_balance_card?: number;

  @ApiPropertyOptional({ example: 'Kunlik smena ochildi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CloseShiftRequestDto {
  @ApiPropertyOptional({ example: '12' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  shift_id?: string;

  @ApiPropertyOptional({ example: '15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @ApiProperty({ example: '15' })
  @IsString()
  @Matches(/^\d+$/)
  closed_by!: string;

  @ApiPropertyOptional({ example: 120000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  closing_balance_cash?: number;

  @ApiPropertyOptional({ example: 50000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  closing_balance_card?: number;

  @ApiPropertyOptional({ example: 'Smena yopildi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class FindShiftQueryDto {
  @ApiPropertyOptional({ example: '15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @ApiPropertyOptional({ enum: ['open', 'closed'], example: 'open' })
  @IsOptional()
  @IsString()
  status?: 'open' | 'closed';

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  from_date?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  to_date?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class CreateSalaryRequestDto {
  @ApiProperty({ example: '3001' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiProperty({ example: 3000000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  salary_amount!: number;

  @ApiPropertyOptional({ example: 3000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  have_to_pay?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;
}

export class UpdateSalaryRequestDto {
  @ApiProperty({ example: '3001' })
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @ApiPropertyOptional({ example: 3500000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  salary_amount?: number;

  @ApiPropertyOptional({ example: 1000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  have_to_pay?: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;

  @ApiPropertyOptional({ example: 250000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  increase_have_to_pay_by?: number;
}

export class PaymentFromCourierRequestDto {
  @ApiProperty({ example: '1001' })
  @IsString()
  @Matches(/^\d+$/)
  courier_id!: string;

  @ApiProperty({ example: 250000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  payment_method!: PaymentMethod;

  @ApiPropertyOptional({ example: '2002' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @ApiPropertyOptional({ example: '2026-03-06T11:00:00Z' })
  @IsOptional()
  @IsString()
  payment_date?: string;

  @ApiPropertyOptional({ example: 'Courierdan tolov olindi' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class PaymentToMarketRequestDto {
  @ApiProperty({ example: '2002' })
  @IsString()
  @Matches(/^\d+$/)
  market_id!: string;

  @ApiProperty({ example: 500000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  payment_method!: PaymentMethod;

  @ApiPropertyOptional({ example: '2026-03-06T12:00:00Z' })
  @IsOptional()
  @IsString()
  payment_date?: string;

  @ApiPropertyOptional({ example: 'Marketga pul o‘tkazma' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class MainCashboxFilterQueryDto {
  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  toDate?: string;
}

export class CashboxAllInfoQueryDto {
  @ApiPropertyOptional({ enum: Operation_type })
  @IsOptional()
  @IsEnum(Operation_type)
  operationType?: Operation_type;

  @ApiPropertyOptional({ enum: Source_type })
  @IsOptional()
  @IsEnum(Source_type)
  sourceType?: Source_type;

  @ApiPropertyOptional({ example: '101' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  createdBy?: string;

  @ApiPropertyOptional({ enum: Cashbox_type })
  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @ApiPropertyOptional({ example: '2026-03-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-03-07T23:59:59Z' })
  @IsOptional()
  @IsString()
  toDate?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class MainCashboxManualRequestDto {
  @ApiProperty({ example: 150000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  type?: PaymentMethod;

  @ApiPropertyOptional({ example: 'Manual operatsiya' })
  @IsOptional()
  @IsString()
  comment?: string;
}
