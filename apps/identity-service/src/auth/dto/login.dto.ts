import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  phone_number!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}
