import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Link between an internal order and its shipment at an external provider
 * (cargo / post / marketplace). Generic across providers — the provider is
 * identified by integration_id / provider_slug, never hard-coded.
 *
 * One active shipment per order (unique order_id): an order ships via one
 * carrier at a time. Re-dispatching to a different carrier resets the row's
 * provider fields rather than creating a second one.
 *
 * Holds both the raw provider status (as last reported) and the mapped
 * internal status, so the UI can show carrier wording while order flow keys
 * off our own vocabulary.
 */
@Entity({ name: 'provider_shipments' })
@Index('IDX_SHIPMENT_ORDER', ['order_id'], { unique: true })
@Index('IDX_SHIPMENT_INTEGRATION', ['integration_id'])
@Index('IDX_SHIPMENT_EXTERNAL_REF', ['external_ref'])
@Index('IDX_SHIPMENT_TRACKING', ['tracking_number'])
@Index('IDX_SHIPMENT_INTERNAL_STATUS', ['internal_status'])
export class ProviderShipment extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  integration_id!: string;

  /** Denormalised provider slug for readable queries without a join. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_slug!: string | null;

  /** The provider's own id for this shipment/order. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  external_ref!: string | null;

  /** Human-facing tracking number, when the provider issues one. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  tracking_number!: string | null;

  /** Last status string exactly as the provider reported it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_status!: string | null;

  /** Provider status mapped to our internal order vocabulary. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  internal_status!: string | null;

  /** When the provider status last changed. */
  @Column({ type: 'timestamptz', nullable: true })
  status_changed_at!: Date | null;

  /** Outbound dispatch attempts (create shipment at the provider). */
  @Column({ type: 'int', default: 0 })
  send_attempts!: number;

  /** Last error from an outbound dispatch attempt. */
  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  /** Idempotency key sent on the last outbound dispatch. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  last_request_id!: string | null;

  /** Free-form provider metadata (label url, cost, etc.). */
  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;
}
