import { Status } from '@app/common';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateInvestorDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @IsOptional()
  @IsString()
  description?: string;

  /** «Ulush (%)» — 0..100, ko'pi bilan 2 kasr. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  share_percent?: number | null;

  /**
   * vpKijXce: investor login (users.id) bilan bog'lash. `null` — bog'lanishni
   * uzish. Servis musbat butun son va takrorlanmasligini tekshiradi.
   */
  @IsOptional()
  @IsString()
  user_id?: string | null;

  /** Foyda asosi: 'net' — sof foydadan, 'gross' — daromaddan. */
  @IsOptional()
  @IsIn(['net', 'gross'])
  profit_basis?: 'net' | 'gross';

  /** Ulush/asos o'zgarishi qaysi kundan (`YYYY-MM-DD`; bo'sh — bugun). */
  @IsOptional()
  @IsString()
  share_effective_from?: string;

  /** «Investorlik sanasi»ni tuzatish — birinchi shart boshi (`YYYY-MM-DD`). */
  @IsOptional()
  @IsString()
  share_started_at?: string;
}
