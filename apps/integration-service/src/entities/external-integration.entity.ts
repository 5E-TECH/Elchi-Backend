import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export type AuthType = 'api_key' | 'login';
export type IntegrationType = 'api' | 'webhook' | 'ftp';
export type IntegrationStatus = 'active' | 'inactive';

@Entity({ name: 'external_integrations' })
@Index('IDX_INTEGRATION_SLUG', ['slug'], { unique: true })
@Index('IDX_INTEGRATION_ACTIVE', ['is_active'])
@Index('IDX_INTEGRATION_MARKET', ['market_id'])
@Index('IDX_INTEGRATION_STATUS', ['status'])
export class ExternalIntegration extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', unique: true })
  slug!: string;

  @Column({ type: 'varchar', default: 'api' })
  type!: IntegrationType;

  @Column({ type: 'varchar', nullable: true })
  base_url!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  credentials!: Record<string, unknown> | null;

  @Column({ type: 'varchar', default: 'active' })
  status!: IntegrationStatus;

  @Column({ type: 'varchar' })
  api_url!: string;

  @Column({ type: 'varchar', nullable: true })
  api_key!: string | null;

  @Column({ type: 'varchar', nullable: true })
  api_secret!: string | null;

  @Column({ type: 'varchar', default: 'api_key' })
  auth_type!: AuthType;

  @Column({ type: 'varchar', nullable: true })
  auth_url!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  field_mapping!: Record<string, string> | null;

  @Column({ type: 'jsonb', nullable: true })
  status_mapping!: Record<string, string> | null;

  @Column({ type: 'jsonb', nullable: true })
  status_sync_config!: Record<string, any> | null;

  // --- Inbound webhook config (provider → Elchi callbacks) ---

  /** Shared secret for verifying inbound webhook HMAC. AES-encrypted at rest. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret!: string | null;

  /** Previous secret, accepted during a rotation window. AES-encrypted. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret_previous!: string | null;

  /** Header carrying the signature, e.g. 'x-signature'. Default applied in code. */
  @Column({ type: 'varchar', nullable: true })
  webhook_signature_header!: string | null;

  /** Optional signature prefix to strip, e.g. 'sha256='. */
  @Column({ type: 'varchar', nullable: true })
  webhook_signature_prefix!: string | null;

  /** HMAC algorithm: 'sha256' (default) | 'sha512' | 'sha1'. */
  @Column({ type: 'varchar', nullable: true })
  webhook_algorithm!: string | null;

  /**
   * Header carrying a unique delivery/event id used for replay protection
   * (e.g. 'x-delivery-id'). When absent, replay protection is best-effort.
   */
  @Column({ type: 'varchar', nullable: true })
  webhook_id_header!: string | null;

  /**
   * Inbound status mapping: provider status code → internal handling.
   * e.g. { "DELIVERED": { "status": "sold", "action": "sell" },
   *        "CANCELLED": { "status": "cancelled", "action": "cancel" } }
   * `action` (sell/cancel/return) marks a terminal transition; absent action
   * means an intermediate status that's only recorded, not acted upon.
   */
  @Column({ type: 'jsonb', nullable: true })
  inbound_status_mapping!: Record<
    string,
    { status?: string; action?: string }
  > | null;

  /**
   * Dot-paths telling us where to read shipment fields out of a webhook
   * payload, so the framework stays provider-agnostic:
   *   { "external_ref": "data.order_id",
   *     "tracking_number": "data.tracking",
   *     "status": "data.status.code",
   *     "event": "event" }
   * Each provider's payload shape is config, not code.
   */
  @Column({ type: 'jsonb', nullable: true })
  webhook_payload_paths!: {
    external_ref?: string;
    tracking_number?: string;
    status?: string;
    event?: string;
  } | null;

  /**
   * Outbound dispatch config — how to create a shipment at this provider.
   * The request body/query are templates interpolated from a flat context
   * (order fields) via {{field}}; response_paths say where the provider's
   * order id / tracking number / status live in the create response.
   *   {
   *     "endpoint": "/orders", "method": "POST", "use_auth": true,
   *     "headers": { "Idempotency-Key": "{{idempotency_key}}" },
   *     "body_template": { "external_id": "{{order_id}}",
   *                        "receiver": { "phone": "{{customer_phone}}" },
   *                        "cod_amount": "{{total_price}}" },
   *     "response_paths": { "external_ref": "data.order_id",
   *                         "tracking_number": "data.tracking_number",
   *                         "status": "data.status" }
   *   }
   */
  @Column({ type: 'jsonb', nullable: true })
  dispatch_config!: {
    endpoint?: string;
    method?: string;
    use_auth?: boolean;
    headers?: Record<string, string>;
    query_template?: Record<string, unknown>;
    body_template?: Record<string, unknown>;
    response_paths?: {
      external_ref?: string;
      tracking_number?: string;
      status?: string;
    };
    timeout_ms?: number;
  } | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_sync_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  total_synced_orders!: number;
}
