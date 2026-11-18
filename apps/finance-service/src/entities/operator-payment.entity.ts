import { Check, Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * Kim yozgan (F2qp6FtE, migratsiya 241):
 *  - `elchi` — eski yo'l: superadmin «Moliya operatorlari» dan yozgan (AUDIT
 *    M6 dan keyin Asosiy kassadan naqd chiqim + «Maosh» xarajati bilan —
 *    `affects_cashbox = true`). Yangi yozuv bu manba bilan YARATILMAYDI.
 *  - `market` — market o'z operatoriga o'zi to'lagani haqida yozuv: kassa,
 *    kassa tarixi, P&L daftari va smenaga TEGMAYDI (`affects_cashbox = false`,
 *    DB CHECK kafolatlaydi).
 */
export const OPERATOR_PAYMENT_SOURCES = ['elchi', 'market'] as const;
export type OperatorPaymentSource = (typeof OPERATOR_PAYMENT_SOURCES)[number];

/** Toshkent bugungi sanasi — DB sukuti (eski yozuvchi `paid_at` bermaydi). */
const TASHKENT_TODAY_SQL = "((now() AT TIME ZONE 'Asia/Tashkent'))::date";

/**
 * A payout to an operator against their accrued earnings. An operator's
 * outstanding balance is SUM(earnings) - SUM(payments that are not deleted and
 * not cancelled). Unlike earnings, payments are not tied to a single order.
 *
 * F2qp6FtE: market o'z operatoriga O'ZI to'laydi — tizim faqat yozuv saqlaydi
 * (summa, sana, kim yozdi, izoh). Xato yozuv o'chirilmaydi, bekor qilinadi
 * (`cancelled_*`, sabab bilan) — qator qoladi, «To'landi» ga kirmaydi.
 */
@Entity({ name: 'operator_payments' })
// Migratsiya 241 dagi CHECK'lar (synchronize'li pg spec'larda ham kuchda).
@Check('CHK_OPERATOR_PAYMENT_SOURCE', `"source" IN ('elchi', 'market')`)
@Check(
  'CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX',
  `"source" <> 'market' OR ("affects_cashbox" = false AND "market_id" IS NOT NULL AND "amount" > 0)`,
)
@Check(
  'CHK_OPERATOR_PAYMENT_CANCEL',
  `"cancelled_at" IS NULL OR ("source" = 'market' AND "cancel_reason" IS NOT NULL AND btrim("cancel_reason") <> '')`,
)
@Index('IDX_OPERATOR_PAYMENT_OPERATOR', ['operator_id'])
@Index('IDX_OPERATOR_PAYMENT_MARKET', ['market_id'])
@Index('IDX_OPERATOR_PAYMENT_CREATED', ['createdAt'])
@Index('IDX_OPERATOR_PAYMENT_MARKET_PAID', ['market_id', 'paid_at'])
@Index('UQ_OPERATOR_PAYMENT_IDEMPOTENCY', ['market_id', 'idempotency_key'], {
  unique: true,
  where: 'idempotency_key IS NOT NULL',
})
export class OperatorPayment extends BaseEntity {
  @Column({ type: 'bigint' })
  operator_id!: string;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  /** Yozuvni yozgan foydalanuvchi (eski yo'lda — admin, yangisida — market). */
  @Column({ type: 'bigint', nullable: true })
  paid_by_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'elchi' })
  source!: OperatorPaymentSource;

  /** Asosiy kassani o'zgartirganmi (faqat eski `elchi` yozuvlarida true). */
  @Column({ type: 'boolean', default: true })
  affects_cashbox!: boolean;

  /** To'lov sanasi, Toshkent kuni (`YYYY-MM-DD`). */
  @Column({ type: 'date', default: () => TASHKENT_TODAY_SQL })
  paid_at!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  recorded_by_role!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotency_key!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  cancelled_by_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  cancelled_by_role!: string | null;

  @Column({ type: 'text', nullable: true })
  cancel_reason!: string | null;
}
