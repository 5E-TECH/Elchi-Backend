import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(6)
  password!: string;
}

export class RefreshRequestDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  @IsString()
  @MinLength(10)
  refreshToken!: string;
}

export class AuthUserDto {
  @ApiProperty({ example: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' })
  id!: string;

  @ApiProperty({ example: 'ali123' })
  username!: string;

  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  phone_number?: string;

  @ApiProperty({ example: 'customer' })
  role!: string;

  @ApiProperty({ example: 'active' })
  status!: string;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  accessToken!: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  refreshToken!: string;
}

export class ValidateResponseDto {
  @ApiProperty({ example: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' })
  id!: string;

  @ApiProperty({ example: 'ali123' })
  username!: string;

  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  name?: string;

  @ApiProperty({ example: 'customer' })
  role!: string;

  @ApiProperty({ example: 'active' })
  status!: string;
}

export class AuthErrorResponseDto {
  @ApiProperty({ example: 401 })
  statusCode!: number;

  @ApiProperty({ example: 'Invalid credentials' })
  message!: string;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'Logged out successfully' })
  message!: string;
}
