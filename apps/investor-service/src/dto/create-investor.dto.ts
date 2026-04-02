import { Status } from '@app/common';
import { IsEnum, IsOptional, IsPhoneNumber, IsString } from 'class-validator';

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

  @IsOptional()
  @IsString()
  user_id?: string;
}
