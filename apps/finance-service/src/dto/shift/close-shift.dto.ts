import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class CloseShiftDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  shift_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @IsString()
  @Matches(/^\d+$/)
  closed_by!: string;

  @IsOptional()
  @IsNumber()
  closing_balance_cash?: number;

  @IsOptional()
  @IsNumber()
  closing_balance_card?: number;

  @IsOptional()
  @IsString()
  comment?: string;
}
