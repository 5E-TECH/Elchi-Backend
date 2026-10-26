import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

// Reusable numeric(20,2) money column config (exact fixed-point; API stays number).
const moneyColumn = {
  type: 'numeric' as const,
  precision: 20,
  scale: 2,
  default: 0,
  transformer: numericTransformer,
};

export enum ShiftStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export type ShiftCloseReason = 'manual' | 'auto';

export type ShiftReportStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'skipped'
  | 'failed';

@Entity({ name: 'shifts' })
@Index('IDX_SHIFT_OPENED_BY', ['opened_by'])
@Index('IDX_SHIFT_STATUS', ['status'])
@Index('IDX_SHIFT_OPENED_AT', ['opened_at'])
// One open shift per user. Migration 1714500000000-EnforceSingleOpenShift
// creates the same index; this decorator keeps the entity authoritative so
// TypeORM schema-sync (if ever enabled) won't drop the constraint.
@Index('IDX_SHIFT_OPENED_BY_OPEN_UNIQUE', ['opened_by'], {
  unique: true,
  where: "status = 'open' AND is_deleted = false",
})
export class Shift extends BaseEntity {
  @Column({ type: 'bigint' })
  opened_by!: string;

  @Column({ type: 'bigint', nullable: true })
  closed_by!: string | null;

  /**
   * Smena QAYSI KASSAGA tegishli (audit M7).
   *
   * Ilgari smena yopilganda kirim/chiqim butun kompaniya bo'yicha —
   * barcha kuryer, market, filial va MAIN kassalari bo'yicha — hisoblanardi.
   * Shu bois "sanab topshirilgan naqd" bilan tizim raqamini solishtirib
   * bo'lmasdi va kamomadni aniqlaydigan nazorat ishlamasdi. Endi yig'indi
   * faqat shu kassa bo'yicha olinadi. Sukut: markaziy MAIN kassa ('0').
   */
  @Column({ type: 'bigint', nullable: true })
  cashbox_user_id!: string | null;

  @Column({ type: 'timestamptz' })
  opened_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at!: Date | null;

  @Column({ type: 'enum', enum: ShiftStatus, default: ShiftStatus.OPEN })
  status!: ShiftStatus;

  @Column(moneyColumn)
  opening_balance_cash!: number;

  @Column(moneyColumn)
  opening_balance_card!: number;

  @Column(moneyColumn)
  closing_balance_cash!: number;

  @Column(moneyColumn)
  closing_balance_card!: number;

  @Column(moneyColumn)
  total_income_cash!: number;

  @Column(moneyColumn)
  total_income_card!: number;

  @Column(moneyColumn)
  total_expense_cash!: number;

  @Column(moneyColumn)
  total_expense_card!: number;

  /**
   * (QTCUUgjA) Smena yopilganda tizim KUTGAN qoldiq:
   * `opening_balance + total_income - total_expense` (naqd va karta alohida).
   * Ochiq smenada va migratsiyadan oldingi smenalarda — NULL.
   */
  @Column({ ...moneyColumn, nullable: true, default: null })
  expected_balance_cash!: number | null;

  @Column({ ...moneyColumn, nullable: true, default: null })
  expected_balance_card!: number | null;

  /**
   * (QTCUUgjA) Kamomad (−) / ortiqcha (+):
   * `closing_balance (sanab topshirilgan) - expected_balance`.
   * Sanalgan summa yuborilmagan bo'lsa — NULL (soxta "kamomad" ko'rsatilmaydi).
   */
  @Column({ ...moneyColumn, nullable: true, default: null })
  discrepancy_cash!: number | null;

  @Column({ ...moneyColumn, nullable: true, default: null })
  discrepancy_card!: number | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  /**
   * (y8Tqm9Ap) Qanday yopildi: `manual` — xodim, `auto` — jadval bo'yicha
   * tizim. Ochiq smenada va migratsiya 167 dan oldin yopilganlarda NULL
   * (API ularni `manual` deb ko'rsatadi).
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  close_reason!: ShiftCloseReason | null;

  /** (y8Tqm9Ap) Tizim yopgan — `closed_by` shunda NULL. */
  @Column({ type: 'boolean', default: false })
  closed_by_system!: boolean;

  /**
   * (gWI4gYkw) Hisobot yuborish navbati: yopish tranzaksiyasida `pending`,
   * ishlov beruvchi `processing` ga atomik da'vo qiladi, so'ng `sent` /
   * `skipped` / `failed`. Eski smenalarda NULL.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  report_status!: ShiftReportStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  report_claimed_at!: Date | null;

  /** Necha marta yuborildi (1 — yopilganda, keyingilari — qayta yuborish). */
  @Column({ type: 'int', default: 0 })
  report_round!: number;

  /** Hisobot fayli (file-service, private) — superadmin ilovasi. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  report_file_key!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  report_file_format!: string | null;
}
