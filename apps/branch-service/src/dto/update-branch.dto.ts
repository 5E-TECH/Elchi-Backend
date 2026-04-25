import { IsEnum, IsNumberString, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { BranchType } from '@app/common';

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  @IsOptional()
  @IsNumberString()
  region_id?: string;

  @IsOptional()
  @IsNumberString()
  district_id?: string;

  @IsOptional()
  @IsNumberString()
  parent_id?: string;

  @IsOptional()
  @IsEnum(BranchType)
  type?: BranchType;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code?: string;

  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @IsOptional()
  @IsNumberString()
  manager_id?: string;
}
