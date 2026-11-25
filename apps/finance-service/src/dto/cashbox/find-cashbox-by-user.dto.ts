import { Cashbox_type, Source_type } from '@app/common';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class FindCashboxByUserDto {
  /** KRN902pg — tarix: to'lov usuli (vergul bilan; servis tekshiradi). */
  @IsOptional()
  @IsString()
  payment_method?: string;

  /** KRN902pg — tarix: karta ID'lari va/yoki `none` (vergul bilan). */
  @IsOptional()
  @IsString()
  card_id?: string;

  /** T3 — `receipt` blokini qo'shish (FAQAT gateway, SA/admin/menejer). */
  @IsOptional()
  @IsBoolean()
  include_receipts?: boolean;

  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

  @IsOptional()
  @IsEnum(Source_type)
  history_source_type?: Source_type;

  @IsOptional()
  @IsString()
  history_source_types?: string;

  @IsOptional()
  @IsString()
  sourceTypes?: string;

  @IsOptional()
  @IsString()
  source_types?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsBoolean()
  with_history?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}
