import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { ExpenseProofCondition, Status, Where_deliver } from '@app/common';

export class UpdateMarketDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  password?: string;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @IsOptional()
  @IsEnum(Where_deliver)
  default_tariff?: Where_deliver;

  @IsOptional()
  @IsBoolean()
  add_order?: boolean;

  @IsOptional()
  @IsBoolean()
  cancelled_handover_qr_required?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(ExpenseProofCondition, { each: true })
  expense_proof_conditions?: ExpenseProofCondition[];

  /** w2bDrE3i: faqat admin/superadmin. */
  @IsOptional()
  @IsBoolean()
  extra_cost_enabled?: boolean;

  /** w2bDrE3i: faqat admin/superadmin. */
  @IsOptional()
  @IsBoolean()
  extra_cost_requires_approval?: boolean;

  /** (ysBqD9Nx) guruh kartasida mijoz PII: market o'zi (gateway — o'z id'si) yoki admin. */
  @IsOptional()
  @IsBoolean()
  tg_group_show_customer_pii?: boolean;

  /** VRyloH62: market o'zi (gateway — faqat o'z id'si) yoki admin. */
  @IsOptional()
  @IsBoolean()
  require_operator_phone?: boolean;

  /** VRyloH62: `+998XXXXXXXXX` ga keltiriladi; null/'' — o'chirish. */
  @IsOptional()
  @IsString()
  default_operator_phone?: string | null;
}
