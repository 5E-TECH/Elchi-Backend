import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BOT_CHECK_ERROR_KINDS, type BotCheckErrorKind } from '@app/common';

/**
 * (BOT-DIAG-BE) `GET /health/notification-bot` va
 * `POST /health/notification-bot/recheck` (faqat superadmin) — Telegram bot
 * holati va oxirgi token tekshiruvi sababi. Bot tokeni hech qaysi maydonda
 * yo'q.
 */
export class NotificationBotDiagnosticsDto {
  @ApiProperty({
    example: true,
    description: 'Bot tokeni sozlanganmi (placeholder emas)',
  })
  enabled!: boolean;

  @ApiProperty({
    enum: ['webhook', 'polling', 'off'],
    example: 'webhook',
    description:
      'Ish rejimi; token rad etilgan yoki transport to‘xtagan — `off`',
  })
  mode!: string;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: false,
    description:
      'Oxirgi getMe natijasi: `true` — sog‘, `false` — o‘tmadi, `null` — hali tekshirilmagan',
  })
  healthy!: boolean | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'elchi_bot',
    description: 'Bot username (oxirgi muvaffaqiyatli getMe dan)',
  })
  username!: string | null;

  @ApiProperty({
    example: 'webhook (secret_token bilan)',
    description: 'Rejim sababi yoki to‘xtash sababi (server matni)',
  })
  reason!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    example: '2026-11-17T21:05:00.000Z',
    description:
      'Oxirgi token tekshiruvi vaqti (ISO). Davriy tekshiruv — har 5 daqiqada; `null` — hali tekshirilmagan (token yo‘q)',
  })
  checked_at!: string | null;

  @ApiProperty({
    enum: BOT_CHECK_ERROR_KINDS,
    nullable: true,
    example: 'network',
    description:
      'Oxirgi tekshiruv xatosi turi: `token_rejected` — Telegram tokenni rad etdi (401/404), qayta tekshirish befoyda, yangi token bilan restart kerak; `timeout` — Telegram javob bermadi; `network` — Telegram’ga ulanib bo‘lmadi (DNS, rad etildi, uzildi); `telegram_error` — Telegram boshqa xato qaytardi (`error_status` bilan, masalan 429, 5xx); `unknown` — kutilmagan xato. Sog‘ yoki tekshirilmagan — `null`',
  })
  error_kind!: BotCheckErrorKind | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description:
      'Telegram HTTP statusi (401, 404, 429, 5xx …); javob kelmagan (timeout/network) yoki sog‘ — `null`',
  })
  error_status!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 200,
    example: 'Telegram getMe failed (0): fetch failed (ENOTFOUND)',
    description:
      'Qisqa texnik sabab (inglizcha server matni, ≤ 200 belgi, token yashirilgan). UI asosiy matnni `error_kind` dan oladi, buni «Texnik tafsilot» sifatida ko‘rsatadi',
  })
  error_text!: string | null;

  @ApiProperty({
    example: false,
    description:
      '`true` — token rad etilgan: «Qayta tekshirish» getMe yurgizmaydi, yangi token bilan notification-service restart kerak',
  })
  restart_required!: boolean;
}

export class NotificationBotHealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    example: 'degraded',
    description:
      'notification-service holati (readiness bilan bir xil): `degraded` — token sozlangan, lekin getMe o‘tmagan',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({ type: NotificationBotDiagnosticsDto })
  bot!: NotificationBotDiagnosticsDto;

  @ApiPropertyOptional({
    example: true,
    description:
      'Faqat `POST …/recheck` javobida: getMe shu so‘rovda yurgizildimi (`false` — token yo‘q yoki rad etilgan, `restart_required`)',
  })
  rechecked?: boolean;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-17T21:05:01.000Z',
    description: 'Javob vaqti',
  })
  timestamp!: string;
}
