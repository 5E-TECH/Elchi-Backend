import { Cashbox_type, Operation_type, PaymentMethod, Source_type } from '@app/common';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class UpdateCashboxBalanceDto {
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

  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @IsEnum(Operation_type)
  operation_type!: Operation_type;

  @IsEnum(Source_type)
  source_type!: Source_type;

  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  created_by?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_id?: string | null;

  // Per-attempt idempotency discriminator (see CashboxHistory.dedup_epoch).
  // Free-form token (a timestamp); omitted/'' for non-sell-flow callers.
  @IsOptional()
  @IsString()
  dedup_epoch?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  source_user_id?: string | null;

  @IsOptional()
  payment_date?: string | Date | null;

  // MinIO object keys of expense-proof files (image/video). Set by
  // order-service for EXTRA_COST events when the market requires proof.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proof_files?: string[];
}
