import { Status } from '@app/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateInvestorDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiPropertyOptional({ enum: Status, default: Status.ACTIVE })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateInvestorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ enum: Status })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateInvestmentDto {
  @ApiProperty()
  @IsString()
  investor_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branch_id?: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: '2026-03-25T00:00:00.000Z' })
  @IsDateString()
  invested_at!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateInvestmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  investor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branch_id?: string;

  @ApiPropertyOptional({ minimum: 0.01 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ example: '2026-03-25T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  invested_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateProfitShareDto {
  @ApiProperty()
  @IsString()
  investor_id!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @ApiProperty({ example: '2026-03-01T00:00:00.000Z' })
  @IsDateString()
  period_start!: string;

  @ApiProperty({ example: '2026-03-31T23:59:59.999Z' })
  @IsDateString()
  period_end!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CalculateProfitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  investor_id?: string;

  @ApiProperty({ example: '2026-03-01T00:00:00.000Z' })
  @IsDateString()
  period_start!: string;

  @ApiProperty({ example: '2026-03-31T23:59:59.999Z' })
  @IsDateString()
  period_end!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
