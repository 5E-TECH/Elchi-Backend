import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateInvestmentDto {
  @IsString()
  investor_id!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsDateString()
  invested_at!: string;

  @IsOptional()
  @IsString()
  branch_id?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
