import { Status } from '@app/common';
import { IsEnum, IsOptional, IsPhoneNumber, IsString } from 'class-validator';

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
}
