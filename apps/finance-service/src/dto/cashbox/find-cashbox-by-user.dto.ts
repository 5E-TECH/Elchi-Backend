import { Cashbox_type } from '@app/common';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

export class FindCashboxByUserDto {
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @IsOptional()
  @IsEnum(Cashbox_type)
  cashbox_type?: Cashbox_type;

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
