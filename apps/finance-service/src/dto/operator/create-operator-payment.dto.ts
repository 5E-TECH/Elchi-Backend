import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
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

  /**
   * (FJVqcUTv) Gateway'dagi `Idempotency-Key` sarlavhasi. Bo'lsa — ayni
   * operator uchun ayni kalit bilan kelgan takroriy so'rov pulni ikkinchi
   * marta yechmaydi, mavjud to'lovni `idempotent: true` bilan qaytaradi.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string | null;
}
