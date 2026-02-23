import { IsNotEmpty, IsNumberString, IsString } from 'class-validator';

export class CreateDistrictDto {
  @IsNotEmpty()
  @IsString()
  name!: string;

  @IsNotEmpty()
  @IsNumberString()
  region_id!: string;
}
