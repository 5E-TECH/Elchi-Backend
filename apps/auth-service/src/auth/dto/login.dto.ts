import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  phone_number!: string;

  @IsString()
  password!: string;
}
