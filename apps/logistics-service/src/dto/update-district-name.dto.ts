import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateDistrictNameDto {
  @IsNotEmpty()
  @IsString()
  name!: string;
}

