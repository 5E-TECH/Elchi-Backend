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

  /**
   * (NDmZMzCP) Login ATAYLAB yumshoq (min 4): mavjud foydalanuvchilar eski
   * paroli bilan kira oladi; yangi siyosatga mos kelmasa javobda
   * `must_change_password: true` — almashtirishga yo'naltiriladi.
   */
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

  @ApiPropertyOptional({
    example: false,
    description:
      "(NDmZMzCP) `true` — parol yangi siyosatga (min 8, xodim 10, oddiy parollar taqiqlangan) mos emas yoki vaqtinchalik: FE «Yangi parol o'rnating» ekraniga yo'naltiradi (PATCH /auth/my-profile `password`, keyin POST /auth/refresh). `PASSWORD_CHANGE_GATE=on` bo'lsa boshqa route'lar 403 `PASSWORD_CHANGE_REQUIRED`.",
  })
  must_change_password?: boolean;
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

/**
 * (Elchi Pochta #3) `GET /auth/sessions` — egasining bitta sessiyasi
 * (qurilmasi). Bitta qurilma — bitta sessiya: shu qurilma qayta kirsa AYNI
 * `id` qaytadi.
 */
export class AuthSessionDto {
  @ApiProperty({ example: '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d' })
  id!: string;

  @ApiProperty({
    enum: ['active', 'expired'],
    example: 'active',
    description:
      "`active` — ishlayapti (refresh muddati o'tmagan, parol o'sha). `expired` — muddati o'tgan yoki parol almashgan, lekin qurilma chiqmagan: UI «Qayta kirish kerak». Shu qurilmadan login AYNI sessiyani tiklaydi; «Chiqarish» uni butunlay yopadi.",
  })
  status!: 'active' | 'expired';

  @ApiProperty({
    example: 'Samsung SM-A515F · Android 13 · Chrome 155',
    nullable: true,
    type: String,
    description:
      "Oxirgi login paytidagi X-Device-Name (≤128, ko'rinmas belgilarsiz) yoki User-Agent dan («Telefon · Android · Chrome»)",
  })
  device_name!: string | null;

  @ApiProperty({
    example: '0b6f3c52-8d0e-4f4a-9a3b-6c1d2e3f4a5b',
    nullable: true,
    type: String,
    description:
      "X-Device-Id (16–128 belgi `[A-Za-z0-9._:-]`, odatda UUID). Yaroqsiz yoki yuborilmagan bo'lsa `null` — u holda har login alohida sessiya",
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
    example: '2026-10-01T06:40:00.000Z',
    description: 'Shu qurilmadan BIRINCHI login (sessiya ochilgan vaqt)',
  })
  first_logged_in_at!: string;

  @ApiProperty({
    example: '2026-10-21T08:15:00.000Z',
    description: 'OXIRGI login vaqti (shu qurilma qayta kirganda yangilanadi)',
  })
  logged_in_at!: string;

  @ApiProperty({
    example: '2026-10-21T10:02:11.000Z',
    description: 'Oxirgi muvaffaqiyatli token yangilanishi (yoki login)',
  })
  last_seen_at!: string;

  @ApiProperty({
    example: '2026-10-22T08:15:00.000Z',
    description:
      'Refresh token muddati (oxirgi login + 1 kun, uzaymaydi) — shundan keyin `status: expired`, qayta login kerak',
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
    description:
      "Shu akkauntning FAQAT `status: 'active'` sessiyalari soni (`expired` lar sanalmaydi)",
  })
  active_count!: number;

  @ApiProperty({
    type: () => [AuthSessionDto],
    description:
      "Ochiq sessiyalar (yopilmagan; muddati 90 kundan ko'p oldin o'tganlari yo'q): avval joriy (`current: true`), keyin `active`, keyin `expired` — har guruh oxirgi faollik bo'yicha kamayish tartibida (ko'pi bilan 50)",
  })
  sessions!: AuthSessionDto[];

  @ApiProperty({
    example: false,
    description:
      "(2026-10-23) Joriy sessiya hozir BOSHQA sessiyalarni yopa oladimi («Chiqarish» / «Boshqa sessiyalardan chiqish»). Joriy sessiya shu qurilmadan birinchi kirilganiga (`first_logged_in_at`) SESSION_REVOKE_LOCK_HOURS (48 soat) to'lmagan bo'lsa — `false`. `sid` siz token (joriy sessiya yo'q) — `false`",
  })
  can_revoke_others!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-25T07:00:00.000Z',
    description:
      "(2026-10-23) Qachondan yopa oladi (ISO, UTC) — `first_logged_in_at` + 48 soat. Hozir mumkin bo'lsa yoki joriy sessiya aniqlanmasa — `null`",
  })
  revoke_available_at!: string | null;
}

export class AuthSessionsResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: () => AuthSessionsDataDto })
  data!: AuthSessionsDataDto;
}

/**
 * (Elchi Pochta #3) `DELETE /auth/sessions/:id` va
 * `POST /auth/sessions/revoke-others` — nechta sessiya yopildi.
 */
export class AuthSessionsRevokeDataDto {
  @ApiProperty({ example: 1, description: 'Yopilgan sessiyalar soni' })
  revoked!: number;

  @ApiProperty({
    type: [String],
    example: ['3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d'],
    description:
      "Yopilgan sessiyalar id lari. Ularning access tokeni bir necha soniyada 401 bo'ladi, refresh ham 401 — o'sha qurilma login sahifasiga chiqadi",
  })
  session_ids!: string[];
}

export class AuthSessionsRevokeResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Sessiya yopildi' })
  message!: string;

  @ApiProperty({ type: () => AuthSessionsRevokeDataDto })
  data!: AuthSessionsRevokeDataDto;
}

/** (Elchi Pochta #3) Sessiya endpointlari xato javobi (global filtr shakli). */
export class AuthSessionsErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'Sessiya topilmadi yoki allaqachon yopilgan' })
  message!: string;

  @ApiPropertyOptional({
    example: '7d0c2a4e-1b2f-4c3d-9e8f-0a1b2c3d4e5f',
    type: String,
  })
  trace_id?: string;
}

/**
 * (Elchi Pochta #3, 2026-10-23) 403 — joriy sessiya 48 soatdan yosh, boshqa
 * sessiyalarni yopa olmaydi. `code` / `available_at` — mashina o'qiydigan
 * maydonlar (matnni emas, `code` ni tekshiring).
 */
export class AuthSessionTooNewErrorResponseDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({
    example:
      "Xavfsizlik uchun yangi qurilmadan boshqa sessiyalarni chiqarib bo'lmaydi — 25.10.2026 12:00 (Toshkent) dan keyin mumkin",
  })
  message!: string;

  @ApiProperty({ example: 'SESSION_TOO_NEW', enum: ['SESSION_TOO_NEW'] })
  code!: 'SESSION_TOO_NEW';

  @ApiProperty({
    example: '2026-10-25T07:00:00.000Z',
    description:
      'Qachondan mumkin (ISO, UTC) — joriy sessiya `first_logged_in_at` + 48 soat',
  })
  available_at!: string;

  @ApiPropertyOptional({
    example: '7d0c2a4e-1b2f-4c3d-9e8f-0a1b2c3d4e5f',
    type: String,
  })
  trace_id?: string;
}
