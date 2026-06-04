import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { FinancialSource_type } from '@app/common';

export class RecordFinancialBalanceDto {
  // Signed: positive = income, negative = expense. The caller chooses the
  // sign to match source_type (MANUAL_INCOME positive, MANUAL_EXPENSE/BILLS/
  // SALARY negative). Service rejects amount === 0.
  @IsNumber()
  amount!: number;

  @IsEnum(FinancialSource_type)
  source_type!: FinancialSource_type;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'order_id must be a bigint-like numeric string',
  })
  order_id?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'related_user_id must be a bigint-like numeric string',
  })
  related_user_id?: string | null;

  @IsOptional()
  @IsString()
  comment?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'created_by must be a bigint-like numeric string',
  })
  created_by?: string | null;
}
