import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type TelegramAiDraftStatus =
  | 'parsing'
  | 'failed'
  | 'empty'
  | 'preview'
  | 'creating'
  | 'created'
  | 'cancelled';

/** Operator yuborgan kirish (rasm baytlari emas — faqat Telegram file_id). */
export interface TelegramAiDraftInput {
  text?: string;
  files?: Array<{ file_id: string; mime?: string | null }>;
}

/**
 * (e7KhaeOO) Botdagi AI buyurtma qoralamasi (migratsiya 128). PII bo'lishi
 * mumkin — `expires_at` dan keyin o'chiriladi (BotMaintenanceService).
 */
@Entity({ name: 'telegram_ai_drafts' })
@Index('IDX_TELEGRAM_AI_DRAFTS_EXPIRES', ['expires_at'])
export class TelegramAiDraft {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  chat_id!: string;

  @Column({ type: 'bigint' })
  actor_user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: TelegramAiDraftStatus;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  input!: TelegramAiDraftInput;

  @Column({ type: 'uuid', nullable: true })
  ai_draft_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  orders!: unknown[] | null;

  @Column({ type: 'jsonb', nullable: true })
  results!: unknown[] | null;

  @Column({ type: 'bigint', nullable: true })
  message_id!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;

  @Column({ type: 'timestamptz', default: () => "now() + interval '24 hours'" })
  expires_at!: Date;
  /**
   * (BOT-3b, migratsiya 1716000000190) Fondagi ishchi AI ishini (parse /
   * confirm) qachon oldi. NULL — navbatda; 2 daqiqadan eski — tiklanadi.
   */
  @Column({ type: 'timestamptz', nullable: true })
  worker_at!: Date | null;
}
