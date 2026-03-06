import { Cashbox_type } from '@app/common';
import { IsEnum, IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class CreateCashboxDto {
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @IsEnum(Cashbox_type)
  cashbox_type!: Cashbox_type;

  @IsOptional()
  @IsNumber()
  balance?: number;

  @IsOptional()
  @IsNumber()
  balance_cash?: number;

  @IsOptional()
  @IsNumber()
  balance_card?: number;
}
