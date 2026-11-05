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
}
