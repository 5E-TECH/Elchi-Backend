import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class UpdateDistrictSatoCodeDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+$/, { message: 'sato_code must contain only digits' })
  sato_code!: string;
}
