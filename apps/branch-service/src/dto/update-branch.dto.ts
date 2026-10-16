import {
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { BranchOwnership, BranchType } from '@app/common';

// 8jtzNlFt: per_order_share son yoki satr bo'lib kelishi mumkin.
const moneyToString = ({ value }: { value: unknown }) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

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

  // 8jtzNlFt: hamkor filial modeli (create DTO'dagi izohga qarang).
  @IsOptional()
  @IsEnum(BranchOwnership)
  ownership?: BranchOwnership;

  @IsOptional()
  @Transform(moneyToString)
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  per_order_share?: string;
}
