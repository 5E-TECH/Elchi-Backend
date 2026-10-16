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

// 8jtzNlFt: per_order_share son (5000) yoki satr ('5000.50') bo'lib kelishi
// mumkin — ikkalasi ham satrga keltirilib bir xil tekshiriladi.
const moneyToString = ({ value }: { value: unknown }) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

export class CreateBranchDto {
  @IsString()
  @MinLength(2)
  name!: string;

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

  @IsEnum(BranchType)
  type!: BranchType;

  @IsString()
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code!: string;

  @IsOptional()
  @IsNumberString()
  manager_id?: string;

  // 8jtzNlFt: hamkor filial modeli. OWNED (standart) — filial hamma pulni
  // HQ'ga topshiradi; PARTNER — har sotilgan buyurtmadan per_order_share ni
  // o'zida olib qoladi (order-service resolveBranchShare).
  @IsOptional()
  @IsEnum(BranchOwnership)
  ownership?: BranchOwnership;

  @IsOptional()
  @Transform(moneyToString)
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  per_order_share?: string;
}
