import { Column, Entity } from 'typeorm';
import { BaseEntity } from '@app/common';
import { ExpenseCategory } from '@app/common/enums';

/**
 * Elchi Pochta №1 — kassa xarajati kategoriyasi (migratsiya 1716000000129).
 * "To'lovlar → Kassa → xarajat" (`PATCH /finance/cashbox/spend`) da
 * tanlanadi; ro'yxatni superadmin boshqaradi (qo'shish / tahrirlash /
 * o'chirish).
 *
 * Nom o'chirilmaganlar orasida noyob — `lower(name)` partial unique indeksi
 * migratsiyada. O'chirish SOFT (`is_deleted`): tarix qatorlari
 * (`cashbox_history.expense_category_name`) nomni snapshot sifatida saqlaydi.
 */
@Entity({ name: 'cashbox_expense_categories' })
export class CashboxExpenseCategory extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** "Nimalar kiradi" — masalan "Benzin, gaz, dizel". */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  /** Tanlov ro'yxatidagi o'rni (kichigi tepada; seed — 1..17). */
  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  /** Oxirgi tahrirlagan / o'chirgan foydalanuvchi. */
  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;

  /**
   * ljVOuNz4 (migratsiya 197) — kassa kategoriyasining yopiq ro'yxatdagi
   * mosi: qo'lda chiqimning daftar qatori va xarajat hisoboti shundan oladi.
   * NULL — aniq mosi yo'q (`other` deb yoziladi).
   */
  @Column({
    type: 'enum',
    enum: ExpenseCategory,
    enumName: 'expense_category_enum',
    nullable: true,
  })
  ledger_category!: ExpenseCategory | null;
}
