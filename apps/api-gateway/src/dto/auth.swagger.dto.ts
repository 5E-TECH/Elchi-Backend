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

  @ApiPropertyOptional({
    example: 1775865600000,
    description: 'Access token expiration time (Unix ms timestamp)',
  })
  accessTokenExpiresAt?: number | null;

  @ApiPropertyOptional({
    example: 1776470400000,
    description: 'Refresh token expiration time (Unix ms timestamp)',
  })
  refreshTokenExpiresAt?: number | null;

  @ApiPropertyOptional({
    example: 1776469500000,
    description: 'Warning time (15 minutes before refresh token expiration, Unix ms)',
  })
  refreshTokenWarnAt?: number | null;

  @ApiPropertyOptional({
    example: 1775865600000,
    description: 'Snake-case alias of accessTokenExpiresAt',
  })
  access_token_expires_at?: number | null;

  @ApiPropertyOptional({
    example: 1776470400000,
    description: 'Snake-case alias of refreshTokenExpiresAt',
  })
  refresh_token_expires_at?: number | null;

  @ApiPropertyOptional({
    example: 1776469500000,
    description: 'Snake-case alias of refreshTokenWarnAt',
  })
  refresh_token_warn_at?: number | null;
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

export class EmptyDataDto {}

export class LogoutResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Logged out successfully' })
  message!: string;

  @ApiProperty({ type: () => EmptyDataDto })
  data!: EmptyDataDto;
}
