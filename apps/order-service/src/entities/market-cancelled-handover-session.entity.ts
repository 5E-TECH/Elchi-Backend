import { BaseEntity } from '@app/common';
import { Column, Entity, Index } from 'typeorm';

@Entity({ name: 'market_cancelled_handover_sessions' })
@Index('UQ_MARKET_CANCELLED_HANDOVER_QR_HASH', ['qr_token_hash'], {
  unique: true,
})
@Index('UQ_MARKET_CANCELLED_HANDOVER_AUTH_HASH', ['authorization_token_hash'], {
  unique: true,
  where: '"authorization_token_hash" IS NOT NULL',
})
@Index('IDX_MARKET_CANCELLED_HANDOVER_MARKET_CREATED', [
  'market_id',
  'createdAt',
])
export class MarketCancelledHandoverSession extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'varchar', length: 64 })
  qr_token_hash!: string;

  @Column({ type: 'timestamptz' })
  qr_expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  scanned_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  scanned_by_user_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  authorization_token_hash!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  authorization_expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  consumed_at!: Date | null;
}
