import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class OpenShiftDto {
  @IsString()
  @Matches(/^\d+$/)
  opened_by!: string;

  @IsOptional()
  @IsNumber()
  opening_balance_cash?: number;

  @IsOptional()
  @IsNumber()
  opening_balance_card?: number;

  @IsOptional()
  @IsString()
  comment?: string;
}
