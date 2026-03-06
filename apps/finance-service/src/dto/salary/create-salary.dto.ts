import { IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class CreateSalaryDto {
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;

  @IsNumber()
  @Min(0.0000001)
  salary_amount!: number;

  @IsOptional()
  @IsNumber()
  have_to_pay?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  payment_day?: number;
}
