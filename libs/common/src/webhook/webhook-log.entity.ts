import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type WebhookLogStatus =
  | 'received'
  | 'verified'
  | 'rejected'
  | 'processed'
  | 'failed';

/**
 * Append-only audit of every webhook request we received from a partner.
 * Keep enough to: (a) replay an event if downstream processing failed,
 * (b) prove what the partner sent during a dispute, (c) trace the timeline
 * via trace_id. The raw body is stored verbatim — secrets in headers
 * (Authorization, x-api-key, signature itself) must be stripped *before*
 * insert by the caller; this table should not become a credential leak.
 */
@Entity({ name: 'webhook_logs' })
@Index('IDX_WEBHOOK_LOG_PARTNER', ['partner', 'created_at'])
@Index('IDX_WEBHOOK_LOG_STATUS', ['status', 'created_at'])
@Index('IDX_WEBHOOK_LOG_CREATED', ['created_at'])
@Index('IDX_WEBHOOK_LOG_EVENT', ['event_type', 'created_at'])
export class WebhookLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  partner!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  event_type!: string | null;

  @Column({ type: 'varchar', length: 32 })
  status!: WebhookLogStatus;

  /** HTTP method + path so a replay tool knows where this was delivered. */
  @Column({ type: 'varchar', length: 8 })
  http_method!: string;

  @Column({ type: 'varchar', length: 500 })
  request_path!: string;

  /** Sanitised request headers — must not contain raw secrets. */
  @Column({ type: 'jsonb', nullable: true })
  headers!: Record<string, unknown> | null;

  /** Raw body bytes as received (limited to a sane max upstream). */
  @Column({ type: 'text', nullable: true })
  raw_body!: string | null;

  /** Parsed payload when JSON; mirrors raw_body for easy querying. */
  @Column({ type: 'jsonb', nullable: true })
  parsed_payload!: Record<string, unknown> | null;

  /** External provider's reference id (e.g. partner's event id). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  external_id!: string | null;

  /** Why we rejected — only set when status='rejected' or 'failed'. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** Linked trace id of the request that received this webhook. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at!: Date | null;
}
