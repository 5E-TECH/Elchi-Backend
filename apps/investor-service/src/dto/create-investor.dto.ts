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

export class CreateInvestorDto {
  @IsString()
  name!: string;

  @IsPhoneNumber('UZ')
  phone_number!: string;

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
  share_percent?: number;

  @IsOptional()
  @IsString()
  user_id?: string;

  /** Foyda asosi: 'net' — sof foydadan (sukut), 'gross' — daromaddan. */
  @IsOptional()
  @IsIn(['net', 'gross'])
  profit_basis?: 'net' | 'gross';

  /** «Investorlik sanasi» — ulush shu kundan hisoblanadi (`YYYY-MM-DD`; bo'sh — bugun). */
  @IsOptional()
  @IsString()
  share_started_at?: string;
}
