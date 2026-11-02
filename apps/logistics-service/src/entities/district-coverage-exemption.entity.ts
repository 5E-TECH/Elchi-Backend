import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Tuman qamrovi IMTIYOZI (ega qarori, 2026-11-02): tuman ko'chirilganda
 * (boshqa viloyatga / boshqa xizmat filialiga) shu paytda eski filial yoki
 * uning kuryeri qo'lidagi ochiq buyurtma eski filialda tugaydi — filial uni
 * o'z kuryerlariga berishda davom etadi (`assertOrdersServedByBranch`).
 * Qoida — `coverage/district-coverage-exemption.ts`.
 *
 * Bitta (buyurtma, filial) — bitta qator; ishlatilganda O'CHMAYDI (kuryer
 * qaytarib bergach ham qayta beriladi). Faqat buyurtma hozir `district_id`
 * tumanida bo'lsa amal qiladi (NULL — eski qator, tumansiz). Keyingi
 * ko'chish shu juftni yangi tumanga qayta yo'naltiradi (`ON CONFLICT … DO
 * UPDATE`). `revoked_at` — qo'lda bekor qilish.
 * FK YO'Q ataylab: buyurtmalar va filiallar boshqa sxemalarda. Migratsiya
 * 1716000000203.
 */
@Entity({ name: 'district_coverage_exemptions' })
@Index(
  'UQ_DISTRICT_COVERAGE_EXEMPTION_ORDER_BRANCH',
  ['order_id', 'branch_id'],
  {
    unique: true,
  },
)
@Index('IDX_DISTRICT_COVERAGE_EXEMPTION_BRANCH', ['branch_id'])
export class DistrictCoverageExemption {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** order-service buyurtma id. */
  @Column({ type: 'bigint' })
  order_id!: string;

  /** Imtiyozli (eski) filial — branch-service filial id. */
  @Column({ type: 'bigint' })
  branch_id!: string;

  /**
   * Ko'chishdan KEYINGI buyurtma tumani (birlashtirishda B): imtiyoz faqat
   * buyurtma hozir shu tumanda bo'lsa amal qiladi.
   */
  @Column({ type: 'bigint', nullable: true })
  district_id!: string | null;

  /**
   * Qaysi amal yozdi: `district_update`, `set_serving_branch`,
   * `clear_serving_branch`, `district_merge`.
   */
  @Column({ type: 'varchar', length: 32 })
  source!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  /** Bekor qilingan payt (NULL — amalda). */
  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;
}
