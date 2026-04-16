import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({ example: '+998900000000' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'ShodiyorAdmin#2026' })
  @IsString()
  @MinLength(4)
  password!: string;
}

export class RefreshRequestDto {
  @ApiPropertyOptional({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'Optional fallback. Normally refresh token is read from httpOnly cookie.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  refreshToken?: string;
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

export class MinimalAuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  accessToken!: string;
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
