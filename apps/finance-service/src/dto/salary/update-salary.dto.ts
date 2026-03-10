import { IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class UpdateSalaryDto {
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.0000001)
  salary_amount?: number;

  @IsOptional()
  @IsNumber()
  have_to_pay?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;

  @IsOptional()
  @IsNumber()
  increase_have_to_pay_by?: number;
}
