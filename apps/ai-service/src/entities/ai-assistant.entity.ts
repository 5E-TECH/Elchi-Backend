import { BaseEntity, numericTransformer } from '@app/common';
import { Column, Entity, Index } from 'typeorm';

/**
 * F7PWp6cK — AI moliyaviy yordamchi jadvallari (`ai_schema`). Migratsiya:
 * `1716000000172-AiAssistant`.
 */

/** Bitta suhbat (foydalanuvchiniki). */
@Entity({ name: 'ai_conversations', schema: 'ai_schema' })
@Index('IDX_AI_CONV_USER_LAST', ['user_id', 'last_message_at'])
export class AiConversation extends BaseEntity {
  @Column({ type: 'bigint' })
  user_id!: string;

  /** Birinchi savoldan (qisqartirilgan) — ro'yxat uchun. */
  @Column({ type: 'varchar', length: 200, default: '' })
  title!: string;

  /** Foydalanuvchi savollari soni. */
  @Column({ type: 'int', default: 0 })
  turns!: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_message_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  input_tokens!: number;

  @Column({ type: 'int', default: 0 })
  output_tokens!: number;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  cost_usd!: number;
}

/**
 * Suhbat xabarlari — AUDIT IZI va API tarixi (append-only).
 *
 * `role`:
 *  - `user` — savol (`text` = asl savol, `content` = API'ga ketgan blok);
 *  - `assistant` — har qadam javobi (`content` = Anthropic content bloklari
 *    o'zgarishsiz, thinking imzolari bilan; `text` = matn qismlari);
 *    yakuniy javob `is_final = true` (+ `sources`);
 *  - `tool` — API'da `user` roli: tool_result bloklari (`content`) va audit
 *    uchun `tool_calls` (nom, kirish, ok, yozuvlar soni, davr).
 */
@Entity({ name: 'ai_messages', schema: 'ai_schema' })
@Index('IDX_AI_MSG_CONV_SEQ', ['conversation_id', 'seq'])
@Index('IDX_AI_MSG_USER_CREATED', ['user_id', 'createdAt'])
export class AiMessage extends BaseEntity {
  @Column({ type: 'bigint' })
  conversation_id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  /** Suhbat ichidagi tartib (1, 2, …). */
  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'varchar', length: 16 })
  role!: 'user' | 'assistant' | 'tool';

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  /** API formatidagi content (tarixni qayta yuborish uchun). */
  @Column({ type: 'jsonb', nullable: true })
  content!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  tool_calls!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  sources!: unknown;

  @Column({ type: 'boolean', default: false })
  is_final!: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true })
  model!: string | null;

  @Column({ type: 'int', nullable: true })
  step!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  stop_reason!: string | null;

  @Column({ type: 'int', default: 0 })
  input_tokens!: number;

  @Column({ type: 'int', default: 0 })
  output_tokens!: number;

  @Column({ type: 'int', default: 0 })
  cache_read_tokens!: number;

  @Column({ type: 'int', default: 0 })
  cache_creation_tokens!: number;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  cost_usd!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;
}

/** ADMIN ruxsati (superadmin tanlaydi). SUPERADMIN'ga qator shart emas. */
@Entity({ name: 'ai_assistant_access', schema: 'ai_schema' })
@Index('UQ_AI_ASSISTANT_ACCESS_USER', ['user_id'], { unique: true })
export class AiAssistantAccess extends BaseEntity {
  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** NULL — sukut (`AI_ASSISTANT_DAILY_LIMIT`). */
  @Column({ type: 'int', nullable: true })
  daily_limit!: number | null;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;
}
