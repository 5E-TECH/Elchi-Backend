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

  /**
   * zkRab9M2 (BG6) — QR yonidagi 6 xonali kod: sha256('MCP:' + qr_token_hash +
   * ':' + pin). Ochiq kod saqlanmaydi; eski sessiyalarda `null` (kod yo'q).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  pin_hash!: string | null;

  /** Noto'g'ri kod soni (5 tasida sessiya bloklanadi). */
  @Column({ type: 'smallint', default: 0 })
  pin_failed_attempts!: number;

  /** 5-xato payti — sessiya QR bilan ham, kod bilan ham ochilmaydi. */
  @Column({ type: 'timestamptz', nullable: true })
  pin_blocked_at!: Date | null;

  /**
   * Ruxsat qanday ochilgan: `qr` (skan) yoki `pin` (kod). Topshirish usuli
   * (`orders.market_handover_method`, tracking `metadata.method`) shundan.
   */
  @Column({ type: 'varchar', length: 8, nullable: true })
  authorized_via!: MarketHandoverAuthorizedVia | null;
}

export type MarketHandoverAuthorizedVia = 'qr' | 'pin';
