import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Roles, Status } from '@app/common';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsEnum(Roles)
  role?: Roles;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;
}
