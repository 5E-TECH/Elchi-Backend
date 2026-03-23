import { IsNotEmpty, IsNumberString, IsOptional, IsString, Matches } from 'class-validator';

export class CreateDistrictDto {
  @IsNotEmpty()
  @IsString()
  name!: string;

  @IsNotEmpty()
  @IsNumberString()
  region_id!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'sato_code must contain only digits' })
  sato_code?: string;
}
