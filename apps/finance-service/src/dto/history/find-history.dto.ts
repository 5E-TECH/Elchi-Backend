import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class FindHistoryDto {
  /** T3 — «Chek holati» filtri (gateway tekshiradi: AI holatlari + `none`). */
  @IsOptional()
  @IsString()
  receipt_status?: string;

  /** T3 — `receipt` blokini qo'shish (FAQAT gateway, SA/admin/menejer). */
  @IsOptional()
  @IsBoolean()
  include_receipts?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  user_id?: string;

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashboxType?: Cashbox_type;

  @IsOptional()
  @IsEnum(Operation_type)
  operation_type?: Operation_type;

  @IsOptional()
  @IsEnum(Source_type)
  source_type?: Source_type;

  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @IsOptional()
  @IsString()
  source_types?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string;

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
  @Min(0)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  limit?: number;
}
