import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * (UQlmQiGT / Mvx0h1Fv #3) Chat holati Postgres'da — xotiradagi Map emas.
 * Deploy/restart va ikkinchi replika holatni yo'qotmaydi.
 *
 * - `state` — FAQAT id'lar va bayroqlar. Mijoz PII (ism, telefon, manzil)
 *   YOZILMAYDI: `BotSessionService.save` naqsh bo'yicha rad etadi.
 * - `expires_at` — TTL 24 soat (har yozuvda suriladi); o'tgan sessiya
 *   o'qilmaydi (yangi `initial` holat) va cron tozalaydi. `NULL` — tizim
 *   qatori (masalan polling offset: `chat_id = 'poll:<slug>'`), o'chmaydi.
 * - `version` — optimistik yangilash: ikki parallel update bitta chat holatini
 *   bir-birining ustiga yozmaydi.
 */
@Entity({ name: 'telegram_sessions' })
@Index('IDX_TG_SESSIONS_EXPIRES', ['expires_at'])
export class TelegramSession {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  chat_id!: string;

  @Column({ type: 'varchar', length: 32 })
  bot_slug!: string;

  @Column({ type: 'bigint', nullable: true })
  user_id!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  state!: Record<string, unknown>;

  @Column({ type: 'integer', default: 0 })
  version!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;
}
