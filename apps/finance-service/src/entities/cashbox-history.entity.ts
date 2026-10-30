import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { Operation_type, Source_type, PaymentMethod } from '@app/common';
import { Cashbox } from './cashbox.entity';

@Entity({ name: 'cashbox_history' })
@Index('IDX_CASHBOX_HISTORY_CASHBOX', ['cashbox_id'])
@Index('IDX_CASHBOX_HISTORY_CREATED_AT', ['createdAt'])
@Index('IDX_CASHBOX_HISTORY_OP_TYPE', ['operation_type'])
@Index('IDX_CASHBOX_HISTORY_SOURCE', ['source_type'])
@Index('IDX_CASHBOX_HISTORY_CREATED_BY', ['created_by'])
// Idempotency guard — duplicate RMQ deliveries of the same finance event must
// not double-write. Partial: NULL source_id (manual adjustments) is exempt.
@Index(
  'IDX_CASHBOX_HISTORY_IDEMPOTENT',
  ['cashbox_id', 'source_type', 'source_id', 'operation_type', 'dedup_epoch'],
  { unique: true, where: 'source_id IS NOT NULL AND is_deleted = false' },
)
// T6 (migratsiya 186) — bitta to'lovning oyoqlari; teskari qator bir oyoqqa bitta.
@Index('IDX_CASHBOX_HISTORY_TRANSFER', ['transfer_id'], {
  where: 'transfer_id IS NOT NULL',
})
@Index('UQ_CASHBOX_HISTORY_REVERSES', ['reverses_history_id'], {
  unique: true,
  where: 'reverses_history_id IS NOT NULL AND is_deleted = false',
})
export class CashboxHistory extends BaseEntity {
  @Column({ type: 'enum', enum: Operation_type })
  operation_type!: Operation_type;

  @Column({ type: 'bigint' })
  cashbox_id!: string;

  @Column({ type: 'enum', enum: Source_type })
  source_type!: Source_type;

  @Column({ type: 'bigint', nullable: true })
  source_id!: string | null;

  // Per-attempt idempotency discriminator. '' for events that should dedup
  // purely on (cashbox, source_type, source_id, operation_type) — the default
  // for all callers except order-service sell/rollback flows, which assign a
  // fresh timestamp token per attempt so a sell → rollback → sell cycle
  // re-applies money correctly instead of being deduped against the prior
  // attempt. Part of IDX_CASHBOX_HISTORY_IDEMPOTENT.
  @Column({ type: 'varchar', default: '' })
  dedup_epoch!: string;

  @Column({ type: 'bigint', nullable: true })
  source_user_id!: string | null;

  /**
   * T6 (migratsiya 186) — bitta to'lovning BARCHA oyoqlari (kuryer EXPENSE +
   * qabul qiluvchi INCOME [+ click_to_market: MAIN EXPENSE + market EXPENSE];
   * marketga to'lov: MAIN + market) uchun umumiy kalit. NULL — bog'lanmagan
   * eski yozuv (tuzatib bo'lmaydi, `LEGACY_UNLINKED`) yoki boshqa tur.
   */
  @Column({ type: 'uuid', nullable: true })
  transfer_id!: string | null;

  /**
   * T6 — `payment_reversal` qatori qaysi asl oyoqni qaytargani. Bitta oyoq
   * bir marta qaytariladi (UNIQUE partial).
   */
  @Column({ type: 'bigint', nullable: true })
  reverses_history_id!: string | null;

  /**
   * (3PE0B03q) "O'tkazma manbasi" — o'tkazmani (click) qaysi xodim kartasi
   * orqali qilgani. Faqat audit ma'lumoti: pul baribir kassaning yagona
   * `balance_card` idan yechiladi (shaxs bo'yicha karta qoldig'i yo'q).
   * `source_user_id` dan ALOHIDA: u kontragent (market / filial / kuryer) va
   * tarix filtrlari (`?source_user_id=`) shunga tayanadi.
   */
  @Column({ type: 'bigint', nullable: true })
  transfer_source_user_id!: string | null;

  /**
   * 3PE0B03q (migratsiya 105) — CLICK kirim/chiqim qaysi NOMLI kartaga
   * (`cashbox_cards`) tegishli. NULL — Asosiy karta (kartasiz harakat).
   */
  @Column({ type: 'bigint', nullable: true })
  card_id!: string | null;

  /**
   * Elchi Pochta №1 (migratsiya 129) — qo'lda chiqim (MANUAL_EXPENSE) qaysi
   * kassa xarajati kategoriyasiga (`cashbox_expense_categories`) yozilgani.
   * NULL — kategoriyasiz (eski qatorlar / kategoriya tanlanmagan chiqim).
   */
  @Column({ type: 'bigint', nullable: true })
  expense_category_id!: string | null;

  /**
   * Kategoriya nomining yozilgan paytdagi SNAPSHOT'i: kategoriya keyin
   * o'chirilsa yoki qayta nomlansa ham tarix qatori shu nomni ko'rsatadi.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  expense_category_name!: string | null;

  // numeric(20,2) — exact fixed-point money (see Cashbox entity note).
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  balance_after!: number;

  // Cash / card split of the balance immediately after this operation.
  // balance_cash_after + balance_card_after == balance_after. Nullable so
  // rows written before this column existed (no reliable split) stay NULL
  // rather than claiming a false 0/0 breakdown.
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  balance_cash_after!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  balance_card_after!: number | null;

  @Column({ type: 'enum', enum: PaymentMethod, default: PaymentMethod.CASH })
  payment_method!: PaymentMethod;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  // MinIO object keys of proof files (image/video) attached to this expense.
  // Only populated for EXTRA_COST rows when the market requires expense proof.
  @Column({ type: 'jsonb', nullable: true })
  proof_files!: string[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  payment_date!: Date | null;

  @ManyToOne(() => Cashbox, (cashbox) => cashbox.history, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'cashbox_id' })
  cashbox!: Cashbox;
}
