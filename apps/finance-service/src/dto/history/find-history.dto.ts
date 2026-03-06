import { Operation_type, Source_type } from '@app/common';
import { IsEnum, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

export class FindHistoryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @IsOptional()
  @IsString()
  from_date?: string;

  @IsOptional()
  @IsString()
  to_date?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}
