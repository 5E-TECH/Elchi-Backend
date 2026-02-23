import { IsNotEmpty, IsNumberString } from 'class-validator';

export class UpdateDistrictDto {
  @IsNotEmpty()
  @IsNumberString()
  assigned_region!: string;
}
