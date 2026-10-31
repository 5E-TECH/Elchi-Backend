import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * - pending — navbatda (`next_attempt_at` kelishini kutadi);
 * - sending — hozir yuborilmoqda (da'vo qilingan);
 * - sent    — Telegram qabul qildi;
 * - dead    — dead-letter: 403 (bloklangan/chiqarilgan), 400 yoki
 *             `max_attempts` tugadi. Qayta urinilmaydi.
 */
export type TelegramOutboxStatus = 'pending' | 'sending' | 'sent' | 'dead';

/**
 * (9HIaV80X #3) Chiquvchi Telegram outbox: xabar AVVAL shu jadvalga
 * yoziladi, keyin yuboriladi. 429 → `retry_after` bo'yicha, 5xx/tarmoq →
 * eksponensial backoff bilan qayta urinish; `max_attempts` dan keyin `dead`.
 * Servis yiqilsa ham xabar yo'qolmaydi (worker keyin yuboradi).
 */
@Entity({ name: 'telegram_outbox' })
@Index('IDX_TG_OUTBOX_DUE', ['status', 'next_attempt_at'])
@Index('IDX_TG_OUTBOX_CREATED', ['created_at'])
export class TelegramOutbox {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  bot_slug!: string;

  @Column({ type: 'varchar', length: 64 })
  chat_id!: string;

  @Column({ type: 'varchar', length: 32, default: 'sendMessage' })
  method!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: TelegramOutboxStatus;

  @Column({ type: 'integer', default: 0 })
  retry_count!: number;

  @Column({ type: 'integer', default: 5 })
  max_attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  next_attempt_at!: Date;

  @Column({ type: 'varchar', length: 300, nullable: true })
  last_error!: string | null;

  @Column({ type: 'varchar', length: 48, nullable: true })
  source!: string | null;

  /**
   * (BOT-3 #4, migratsiya 1716000000191) Guruh kartasi xabari bo'lsa — qaysi
   * buyurtmaniki: yuborilganda `telegram_order_cards.message_id` yoziladi.
   */
  @Column({ type: 'bigint', nullable: true })
  card_order_id!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;

  /**
   * (BOT-3c) Shu xabar yetkazilishi yakunlaydigan inbox qatorlari —
   * `sent` / `dead` da ularning `delivery.telegram` ini outbox ishchisi yozadi.
   */
  @Column({ type: 'bigint', array: true, nullable: true })
  notification_ids!: string[] | null;
}
