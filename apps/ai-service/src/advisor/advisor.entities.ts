import { BaseEntity, numericTransformer } from '@app/common';
import { Column, Entity, Index } from 'typeorm';

/**
 * BE-5 (LhTIno57) — AI maslahatchi jadvallari (`ai_schema`). Migratsiya:
 * `1716000000224-AiAdvisorAlerts`. API shartnomasi v0.3 §5.
 */

/**
 * Ogohlantirish — haqiqat manbai (audit best-effort). Indekslar (qisman
 * UNIQUE, `DESC` yo'nalishlari) faqat migratsiyada — `synchronize` yo'q.
 */
@Entity({ name: 'ai_advisor_alerts', schema: 'ai_schema' })
export class AiAdvisorAlert extends BaseEntity {
  @Column({ type: 'varchar', length: 4 })
  rule_key!: string;

  @Column({ type: 'varchar', length: 16 })
  severity!: string;

  @Column({ type: 'varchar', length: 16, default: 'new' })
  status!: string;

  /** Qaysi ishlashlar bitta ogohlantirish (`R1:cashbox:7`). */
  @Column({ type: 'varchar', length: 200 })
  dedup_key!: string;

  /** Server yozgan o'zbekcha sarlavha (Telegram/inbox bilan bir xil). */
  @Column({ type: 'varchar', length: 200, default: '' })
  title!: string;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  /** `BranchRef` snapshot (`{id, name}`) yoki null. */
  @Column({ type: 'jsonb', nullable: true })
  branch!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  subject!: Record<string, unknown>;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  headline_amount!: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  facts!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  evidence!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  links!: unknown[];

  /** Ochilgan paytdagi `{key, severity, thresholds}` (§5.2 `rule`). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  rule_snapshot!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  occurrences!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  first_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  first_fact_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_fact_at!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'none' })
  explanation_status!: string;

  @Column({ type: 'text', nullable: true })
  explanation_md!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  explanation_error!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  explanation_error_scope!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  explanation_retry_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  explanation_requested_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  explained_at!: Date | null;

  /** Faqat DB/audit — REST'da yo'q. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  explanation_model!: string | null;

  /** Faqat DB/audit — REST'da yo'q. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  kb_version!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  seen_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  seen_by!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  seen_by_name!: string | null;

  /** «Hal qilindi» YOKI «Ahamiyatsiz» vaqti (`status` farqlaydi). */
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  resolved_by!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  resolved_by_name!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resolution_note!: string | null;

  @Column({ type: 'bigint', nullable: true })
  reopened_from_id!: string | null;

  /** Bildirishnoma javobidan KEYIN yoziladi (§9.2). */
  @Column({ type: 'timestamptz', nullable: true })
  notified_at!: Date | null;

  /** `backfill` va h.k. — dispatch qilinmagan sabab. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  notify_skipped!: string | null;
}

/** Takror (alohida `fact_key`) — `history` va dedup manbai. */
@Entity({ name: 'ai_advisor_alert_occurrences', schema: 'ai_schema' })
@Index('UQ_AI_ADVISOR_OCC_DEDUP_FACT', ['dedup_key', 'fact_key'], {
  unique: true,
})
@Index('IDX_AI_ADVISOR_OCC_ALERT', ['alert_id', 'occurred_at'])
export class AiAdvisorAlertOccurrence extends BaseEntity {
  @Column({ type: 'bigint' })
  alert_id!: string;

  @Column({ type: 'varchar', length: 200 })
  dedup_key!: string;

  @Column({ type: 'varchar', length: 200 })
  fact_key!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurred_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  fact_at!: Date | null;
}

/** Sozlama kaliti (`rules`; BE-1: `telegram`, `budget`, `schedule`). */
@Entity({ name: 'ai_advisor_settings', schema: 'ai_schema' })
@Index('UQ_AI_ADVISOR_SETTINGS_KEY', ['key'], { unique: true })
export class AiAdvisorSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  value!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  updated_by_name!: string | null;
}

/** Qoida holati: kursor, birinchi/oxirgi ishga tushish (migratsiya 226). */
@Entity({ name: 'ai_advisor_rule_state', schema: 'ai_schema' })
@Index('UQ_AI_ADVISOR_RULE_STATE_RULE', ['rule_key'], { unique: true })
export class AiAdvisorRuleState extends BaseEntity {
  @Column({ type: 'varchar', length: 4 })
  rule_key!: string;

  @Column({ type: 'timestamptz', nullable: true })
  cursor_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  first_run_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_run_at!: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  last_status!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  last_error!: string | null;

  @Column({ type: 'int', default: 0 })
  last_candidates!: number;
}
