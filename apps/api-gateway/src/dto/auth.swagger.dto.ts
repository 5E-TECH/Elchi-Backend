import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  MinLength,
} from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({ example: '+998900000000' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: '0990' })
  @IsString()
  @MinLength(4)
  password!: string;
}

export class RefreshRequestDto {
  @ApiPropertyOptional({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description:
      'Optional fallback. Normally refresh token is read from httpOnly cookie.',
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

  @ApiPropertyOptional({ example: 1792497600000, nullable: true })
  accessTokenExpiresAt?: number | null;

  @ApiPropertyOptional({ example: 1793102400000, nullable: true })
  refreshTokenExpiresAt?: number | null;

  @ApiPropertyOptional({ example: 1793101500000, nullable: true })
  refreshTokenWarnAt?: number | null;

  @ApiPropertyOptional({ example: 1792497600000, nullable: true })
  access_token_expires_at?: number | null;

  @ApiPropertyOptional({ example: 1793102400000, nullable: true })
  refresh_token_expires_at?: number | null;

  @ApiPropertyOptional({ example: 1793101500000, nullable: true })
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

/** (Elchi Pochta #3) `GET /auth/sessions` — egasining bitta faol sessiyasi. */
export class AuthSessionDto {
  @ApiProperty({ example: '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d' })
  id!: string;

  @ApiProperty({
    example: 'Telefon · Android · Chrome',
    nullable: true,
    type: String,
    description: 'X-Device-Name yoki User-Agent dan (login paytida)',
  })
  device_name!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description: 'X-Device-Id (frontend yuborsa)',
  })
  device_id!: string | null;

  @ApiProperty({
    example: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile',
    nullable: true,
    type: String,
  })
  user_agent!: string | null;

  @ApiProperty({ example: '203.0.113.7', nullable: true, type: String })
  ip!: string | null;

  @ApiProperty({
    example: '2026-10-21T08:15:00.000Z',
    description: 'Login vaqti',
  })
  logged_in_at!: string;

  @ApiProperty({
    example: '2026-10-21T10:02:11.000Z',
    description: 'Oxirgi muvaffaqiyatli token yangilanishi (yoki login)',
  })
  last_seen_at!: string;

  @ApiProperty({
    example: '2026-10-22T08:15:00.000Z',
    description: 'Refresh token muddati — shundan keyin qayta login kerak',
  })
  expires_at!: string;

  @ApiProperty({
    example: true,
    description: "So'rov yuborgan sessiyaning o'zi",
  })
  current!: boolean;
}

export class AuthSessionsDataDto {
  @ApiProperty({
    example: 2,
    description: 'Shu akkauntning faol sessiyalari soni',
  })
  active_count!: number;

  @ApiProperty({
    type: () => [AuthSessionDto],
    description:
      "Faol sessiyalar, oxirgi faollik bo'yicha kamayish tartibida (ko'pi bilan 50)",
  })
  sessions!: AuthSessionDto[];
}

export class AuthSessionsResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: () => AuthSessionsDataDto })
  data!: AuthSessionsDataDto;
}
