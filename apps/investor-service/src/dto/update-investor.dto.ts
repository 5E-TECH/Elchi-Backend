import { Status } from '@app/common';
import {
  IsEnum,
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
}
