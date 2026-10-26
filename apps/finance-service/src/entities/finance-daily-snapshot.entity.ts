import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * qzjTMWPb (migratsiya 176) — kompaniya moliyaviy holatining kunlik
 * SNAPSHOT'i (Toshkent kuni oxiri). O'QISH MODELI: pul harakati emas.
 *
 * `source`:
 *  - `live`     — kun tugagach (ertasi kuni) yozilgan: zanjirdagi qarz va
 *                 kargo qarzi o'sha payt order/integration'dan olingan;
 *  - `backfill` — o'tgan kun tarixdan qayta qurilgan: kassa yig'indilari va
 *                 daftar qoldig'i aniq, `chain_receivable`/`provider_receivable`
 *                 /`current_situation` esa NULL (tarixdan tiklab bo'lmaydi).
 */
@Entity({ name: 'finance_daily_snapshots' })
@Index('UQ_FINANCE_DAILY_SNAPSHOT_DATE', ['snapshot_date'], { unique: true })
export class FinanceDailySnapshot extends BaseEntity {
  @Column({ type: 'date' })
  snapshot_date!: string;

  @Column({ type: 'varchar', length: 16 })
  source!: 'live' | 'backfill';

  @Column({ type: 'timestamptz', default: () => 'now()' })
  captured_at!: Date;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  main_balance!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  main_balance_cash!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  main_balance_card!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  branch_cashbox_total!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  courier_cashbox_total!: number;

  /** Market kassalarining IMZOLI yig'indisi (musbat = marketlarga qarzmiz). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  market_cashbox_total!: number;

  /** Faqat MUSBAT market kassalari — «Berilishi kerak» (audit M16). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  market_payable_total!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  chain_receivable!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  provider_receivable!: number | null;

  /** `main + chain + provider − market_cashbox_total` (financialBalance formulasi). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  current_situation!: number | null;

  /** P&L daftari (`financial_balance_history`) kun oxiridagi qoldig'i. */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  ledger_balance!: number | null;

  @Column({ type: 'integer', default: 0 })
  cashbox_count!: number;
}
