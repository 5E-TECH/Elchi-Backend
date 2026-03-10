import { IsEnum, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ShiftStatus } from '../../entities/shift.entity';

export class FindShiftsDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @IsOptional()
  @IsEnum(ShiftStatus)
  status?: ShiftStatus;

  @IsOptional()
  @IsString()
  from_date?: string;

  @IsOptional()
  @IsString()
  to_date?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}
