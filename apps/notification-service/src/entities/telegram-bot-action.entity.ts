import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * (Pq2dFj8A #1 / UQlmQiGT #3) Inline tugma holati. `callback_data` faqat
 * `a:<action_id>` (16 belgi) — 64 bayt chegarasi ichida; qolgan holat shu
 * qatordan tiklanadi (xotiradagi msg_id/Map'ga tayanilmaydi).
 *
 * - `actor_user_id` — tugma KIMGA berilgan (guruhda begona a'zo bossa rad).
 * - `consumed_at` — bir martalik amal: shartli UPDATE bilan band qilinadi,
 *   ikkinchi bosish "allaqachon bajarilgan" oladi.
 * - `payload` — faqat id'lar (PII yo'q).
 */
@Entity({ name: 'telegram_bot_actions' })
@Index('IDX_TG_BOT_ACTIONS_EXPIRES', ['expires_at'])
export class TelegramBotAction {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  action_id!: string;

  @Column({ type: 'varchar', length: 64 })
  chat_id!: string;

  @Column({ type: 'bigint', nullable: true })
  message_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  order_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  actor_user_id!: string | null;

  @Column({ type: 'varchar', length: 32 })
  action!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ type: 'boolean', default: true })
  one_shot!: boolean;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumed_at!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;
}
