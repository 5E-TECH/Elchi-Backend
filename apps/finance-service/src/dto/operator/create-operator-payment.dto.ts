import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
} from 'class-validator';

export class CreateOperatorPaymentDto {
  @IsString()
  @Matches(/^\d+$/, {
    message: 'operator_id must be a bigint-like numeric string',
  })
  operator_id!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'market_id must be a bigint-like numeric string',
  })
  market_id?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'paid_by_id must be a bigint-like numeric string',
  })
  paid_by_id?: string | null;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string | null;
}
