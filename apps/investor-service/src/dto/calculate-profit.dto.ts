import { IsDateString, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CalculateProfitDto {
  @IsOptional()
  @IsString()
  investor_id?: string;

  @IsDateString()
  period_start!: string;

  @IsDateString()
  period_end!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @IsOptional()
  @IsString()
  description?: string;
}
