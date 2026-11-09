import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * BUGUNGI QABUL VAQTI (ega 2026-11-09) — gateway DTO'si va Swagger matni.
 * Darvoza order-service'da (`order.create` / `order.external.create` /
 * `order.receive_external` — idempotency'dan oldin): yopiq qabulda 409
 * `ORDER_INTAKE_CLOSED` gateway filtri orqali `code`, `reopens_at`,
 * `cutoff_time` bilan FE'ga yetadi.
 */

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `PATCH /orders/intake-settings` — faqat SUPERADMIN. */
export class UpdateOrderIntakeSettingsRequestDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10:00',
    description:
      'BUGUNGI ish kuni uchun qabul tugash vaqti (Toshkent, `HH:MM`). Shu vaqtdan kun almashguncha ' +
      "yangi buyurtma yaratilmaydi (409 `ORDER_INTAKE_CLOSED`). `null` — cheklovni olib tashlash. O'tgan " +
      "vaqt qo'yilsa qabul darhol yopiladi. Kun almashganda o'zi bekor bo'ladi.",
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
    example: '00:00',
    description:
      'Kun almashish soati (Toshkent, `HH:MM`, sukut `00:00`) — ish kuni shu soatdan keyingi kun ' +
      'shu soatgacha. `null` — sukutga qaytarish. Hozircha faqat bugungi qabul oynasini belgilaydi ' +
      '(hisobot / pochta / smena kunlari 00:00 bo`yicha qoladi).',
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
  'is_open: boolean, closes_at: ISO | null, reopens_at: ISO | null, day_change_time: "HH:MM", ' +
  'day_started_at: ISO, next_day_change_at: ISO } }';
