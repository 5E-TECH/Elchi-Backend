import { IsOptional, IsPhoneNumber, IsString } from 'class-validator';

export class UpdateOwnMarketDto {
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @IsOptional()
  @IsString()
  password?: string;
}
