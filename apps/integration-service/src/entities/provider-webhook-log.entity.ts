import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export type WebhookLogStatus =
  | 'received'
  | 'verified'
  | 'rejected'
  | 'processed'
  | 'failed';

/**
 * Audit + replay-protection log for inbound provider webhooks.
 *
 * Generic across providers: every callback (cargo, post, marketplace) lands
 * here. The (integration_id, delivery_id) pair is unique — a provider that
 * sends a delivery/event id lets us reject duplicate deliveries idempotently.
 * Providers without a delivery id get best-effort logging (delivery_id NULL),
 * no replay guard.
 *
 * raw_payload stores the body verbatim for replay/dispute; callers MUST strip
 * secrets from headers before persisting (the signature header itself is fine
 * to drop). This table must not become a credential leak.
 */
@Entity({ name: 'provider_webhook_logs' })
@Index('IDX_PWH_INTEGRATION', ['integration_id', 'createdAt'])
@Index('IDX_PWH_STATUS', ['status', 'createdAt'])
@Index('IDX_PWH_EVENT', ['event_type', 'createdAt'])
@Index('IDX_PWH_DELIVERY', ['integration_id', 'delivery_id'], {
  unique: true,
  where: 'delivery_id IS NOT NULL',
})
export class ProviderWebhookLog extends BaseEntity {
  @Column({ type: 'bigint', nullable: true })
  integration_id!: string | null;

  /** Provider slug, denormalised so logs are readable without a join. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_slug!: string | null;

  /** Provider-supplied unique delivery/event id; drives replay protection. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  delivery_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  event_type!: string | null;

  @Column({ type: 'boolean', default: false })
  signature_valid!: boolean;

  @Column({ type: 'varchar', length: 16 })
  status!: WebhookLogStatus;

  /** Raw request body as received (secrets must be stripped by the caller). */
  @Column({ type: 'text', nullable: true })
  raw_body!: string | null;

  /** Parsed JSON payload, when the body was valid JSON. */
  @Column({ type: 'jsonb', nullable: true })
  parsed_payload!: Record<string, unknown> | null;

  /** Why it was rejected/failed — only set on the unhappy path. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at!: Date | null;
}
