import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import {
  DEFAULT_TELEGRAM_DM_DELIVERY_TYPE,
  TELEGRAM_DM_DELIVERY_TYPES,
  type TelegramDmDeliveryType,
} from '@app/common';

/** (2crjWf7v) `GET /telegram/dm-delivery` so'rovi. */
export class TelegramDmDeliveryQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Davr boshi (ISO 8601; faqat sana — Toshkent kuni boshidan). Sukut — `to` dan 30 kun oldin.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-23',
    description:
      'Davr oxiri (ISO 8601; faqat sana — shu Toshkent kuni OXIRIGACHA). Sukut — bugun oxirigacha.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: TELEGRAM_DM_DELIVERY_TYPES,
    default: DEFAULT_TELEGRAM_DM_DELIVERY_TYPE,
    description:
      "Bildirishnoma turi: `finance.payment_received` — to'lov kvitansiyasi (kuryer/market), `finance.payment_disputed` — kuryer e'tirozi, `finance.cash_reminder` — kassa eslatmasi.",
  })
  @IsOptional()
  @IsIn(TELEGRAM_DM_DELIVERY_TYPES)
  type?: TelegramDmDeliveryType;
}

export class TelegramDmDeliveryCountsDto {
  @ApiProperty({
    example: 120,
    description: "Telegram DM so'ralgan qatorlar (qabul qiluvchilar) soni",
  })
  total!: number;

  @ApiProperty({ example: 90, description: 'Telegram qabul qildi (yetdi)' })
  sent!: number;

  @ApiProperty({
    example: 4,
    description: 'Yuborishga urinildi, xato (bloklagan, chat topilmadi, …)',
  })
  failed!: number;

  @ApiProperty({
    example: 1,
    description: 'Navbatda / yuborilmoqda (queued | sending | pending)',
  })
  pending!: number;

  @ApiProperty({
    example: 25,
    description:
      'Ataylab yuborilmadi (Telegram ulanmagan, botni bloklagan, o‘chirib qo‘ygan, …) — sabablar `skipped_reasons` da',
  })
  skipped!: number;

  @ApiProperty({ example: 0, description: 'Bot tokeni sozlanmagan' })
  no_provider!: number;

  @ApiProperty({ example: 0, description: 'Boshqa (kutilmagan) holat' })
  other!: number;

  @ApiProperty({
    example: 0.947,
    nullable: true,
    type: Number,
    description:
      'sent / (sent + failed + pending), 0..1 (3 xona); maxraj 0 → null. Yuborilganlardan yetgani.',
  })
  delivery_ratio!: number | null;

  @ApiProperty({
    example: 0.75,
    nullable: true,
    type: Number,
    description:
      'sent / total, 0..1 (3 xona); maxraj 0 → null. Barcha qabul qiluvchilardan (ulanmaganlar ham) yetgani.',
  })
  reach_ratio!: number | null;
}

export class TelegramDmDeliveryRoleDto extends TelegramDmDeliveryCountsDto {
  @ApiProperty({
    example: 'courier',
    description:
      'Qabul qiluvchi roli (`recipient_role`; yo‘q bo‘lsa `unknown`)',
  })
  role!: string;
}

export class TelegramDmDeliveryDayDto extends TelegramDmDeliveryCountsDto {
  @ApiProperty({ example: '2026-10-22', description: 'Toshkent kuni' })
  day!: string;
}

export class TelegramDmDeliveryDataDto {
  @ApiProperty({
    enum: TELEGRAM_DM_DELIVERY_TYPES,
    example: DEFAULT_TELEGRAM_DM_DELIVERY_TYPE,
  })
  type!: TelegramDmDeliveryType;

  @ApiProperty({
    example: '2026-09-22T19:00:00.000Z',
    description: 'Davr boshi (shu jumladan)',
  })
  from!: string;

  @ApiProperty({
    example: '2026-10-23T19:00:00.000Z',
    description: 'Davr oxiri (shu vaqtgacha, kirmaydi)',
  })
  to!: string;

  @ApiProperty({ type: TelegramDmDeliveryCountsDto })
  totals!: TelegramDmDeliveryCountsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { no_telegram_id: 20, bot_blocked: 3, muted: 2 },
    description:
      '`skipped` sabablari bo‘yicha (`no_telegram_id`, `not_private_chat`, `bot_blocked`, foydalanuvchi sozlamasi, …; sababsiz — `unknown`)',
  })
  skipped_reasons!: Record<string, number>;

  @ApiProperty({
    type: [TelegramDmDeliveryRoleDto],
    description: 'Rol bo‘yicha (alifbo tartibida)',
  })
  by_role!: TelegramDmDeliveryRoleDto[];

  @ApiProperty({
    type: [TelegramDmDeliveryDayDto],
    description:
      'Toshkent kunlari bo‘yicha (o‘sish tartibida; bo‘sh kunlar yo‘q)',
  })
  days!: TelegramDmDeliveryDayDto[];
}

export class TelegramDmDeliveryResponseDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'success' })
  message!: string;

  @ApiProperty({ type: TelegramDmDeliveryDataDto })
  data!: TelegramDmDeliveryDataDto;
}
