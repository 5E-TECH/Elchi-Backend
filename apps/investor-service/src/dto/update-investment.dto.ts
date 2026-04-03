import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateInvestmentDto {
  @IsOptional()
  @IsString()
  investor_id?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsDateString()
  invested_at?: string;

  @IsOptional()
  @IsString()
  branch_id?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
