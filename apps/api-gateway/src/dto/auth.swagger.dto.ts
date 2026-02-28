import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({ example: '+998905234382' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: '0990' })
  @IsString()
  @MinLength(4)
  password!: string;
}

export class RefreshRequestDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  @IsString()
  @MinLength(10)
  refreshToken!: string;
}

export class AuthUserDto {
  @ApiProperty({ example: '1' })
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
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  accessToken!: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  refreshToken!: string;
}

export class ValidateResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class AuthErrorResponseDto {
  @ApiProperty({ example: 401 })
  statusCode!: number;

  @ApiProperty({ example: 'Invalid credentials' })
  message!: string;

  @ApiPropertyOptional({ example: null })
  data?: null;
}

export class LogoutResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Logged out successfully' })
  message!: string;

  @ApiProperty({ example: {} })
  data!: Record<string, never>;
}
