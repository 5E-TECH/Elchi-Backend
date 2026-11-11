import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * «KUN TARTIBI» (ega 2026-11-09 / 2026-11-11) — gateway DTO'si va Swagger
 * matni. Darvozalar order-service'da:
 *  - yaratish (`order.create` / `order.external.create` /
 *    `order.receive_external` — idempotency'dan oldin) → 409
 *    `ORDER_INTAKE_CLOSED` (`reopens_at`, `cutoff_time`);
 *  - qabul qilish (`order.receive`, `order.receive_by_scan`) → 409
 *    `ORDER_RECEIVE_CLOSED` (`reopens_at`, `receive_cutoff_time`).
 * Ikkala kod ham gateway filtri orqali FE'ga yetadi (`PUBLIC_ERROR_CODES`).
 */

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `PATCH /orders/intake-settings` — faqat SUPERADMIN; bir nechta maydon birga. */
export class UpdateOrderIntakeSettingsRequestDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10:00',
    description:
      'Buyurtma YARATISH chegarasi (Toshkent, `HH:MM`) — HAR ISH KUNI takrorlanadi, boshqa vaqtga ' +
      "o'zgartirilmaguncha. Shu vaqtdan kun almashguncha yangi buyurtma yaratilmaydi (409 " +
      "`ORDER_INTAKE_CLOSED`). `null` — chegarani olib tashlash. Bugun o'tgan vaqt qo'yilsa yaratish " +
      'darhol yopiladi.',
  })
  @IsOptional()
  @Matches(CLOCK_PATTERN, {
    message:
      "cutoff_time HH:MM ko'rinishida bo'lishi kerak (00:00–23:59, masalan 10:00)",
  })
  cutoff_time?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '16:00',
    description:
      'Yaratilgan buyurtmalarni QABUL QILISH chegarasi (Toshkent, `HH:MM`) — har ish kuni. Shu vaqtdan ' +
      'kun almashguncha `POST /orders/receive` va `POST /orders/external/receive-by-scan` → 409 ' +
      '`ORDER_RECEIVE_CLOSED`. `null` — chegarani olib tashlash.',
  })
  @IsOptional()
  @Matches(CLOCK_PATTERN, {
    message:
      "receive_cutoff_time HH:MM ko'rinishida bo'lishi kerak (00:00–23:59, masalan 16:00)",
  })
  receive_cutoff_time?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '00:00',
    description:
      'Kun almashish soati (Toshkent, `HH:MM`, sukut `00:00`) — ish kuni shu soatdan keyingi kun ' +
      'shu soatgacha. `null` — sukutga qaytarish. Faqat buyurtma yaratish / qabul qilish oynasini ' +
      'belgilaydi (hisobot / pochta / smena kunlari 00:00 bo`yicha qoladi).',
  })
  @IsOptional()
  @Matches(CLOCK_PATTERN, {
    message:
      "day_change_time HH:MM ko'rinishida bo'lishi kerak (00:00–23:59, masalan 00:00)",
  })
  day_change_time?: string | null;
}

/** Swagger: `GET|PATCH /orders/intake-settings` javobi. */
export const ORDER_INTAKE_STATE_DESCRIPTION =
  "{ statusCode: 200, message: 'success', data: { cutoff_time: '10:00' | null, date: 'YYYY-MM-DD', " +
  'is_open: boolean, closes_at: ISO | null, reopens_at: ISO | null, ' +
  "receive_cutoff_time: '16:00' | null, receive_is_open: boolean, receive_closes_at: ISO | null, " +
  'receive_reopens_at: ISO | null, day_change_time: "HH:MM", day_started_at: ISO, ' +
  'next_day_change_at: ISO } }';
