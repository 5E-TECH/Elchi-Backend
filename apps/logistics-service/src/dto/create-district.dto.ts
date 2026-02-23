import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateDistrictDto {
  @IsNotEmpty()
  @IsString()
  name!: string;

  @IsNotEmpty()
  @IsUUID()
  region_id!: string;
}

