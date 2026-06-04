import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * A remittance: a payment the provider sent to Elchi to settle outstanding COD
 * receivables. Creating one settles a set of PENDING receivables (explicit
 * order ids, or FIFO up to `amount`) and records the audit trail of who/when.
 *
 * This is a reconciliation ledger only — it does NOT post to a cashbox. Which
 * cashbox a provider remittance lands in (and how a provider fee is split) is a
 * finance-policy decision left to the business; an operator records the matching
 * cashbox income separately.
 */
@Entity({ name: 'provider_remittances' })
@Index('IDX_REMITTANCE_INTEGRATION', ['integration_id'])
export class ProviderRemittance extends BaseEntity {
  @Column({ type: 'bigint' })
  integration_id!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  amount!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'int', default: 0 })
  settled_count!: number;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
