import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class UpdateDistrictSatoCodeDto {
  /** Tuman SOATO kodi — aniq 7 raqam (viloyat kodi 4 raqam). */
  @IsNotEmpty({ message: 'Tuman SOATO kodi majburiy' })
  @IsString()
  @Matches(/^\d{7}$/, {
    message: "Tuman SOATO kodi aniq 7 ta raqamdan iborat bo'lishi kerak",
  })
  sato_code!: string;
}
