import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Region } from './region.entity';

@Entity({ name: 'districts' })
@Index('IDX_DISTRICT_REGION', ['region_id'])
@Index('IDX_DISTRICT_SATO_CODE', ['sato_code'])
@Index('IDX_DISTRICT_SERVING_BRANCH', ['serving_branch_id'])
/**
 * SlMjauWC (N5): bitta rasmiy kod = bitta (o'chirilmagan) tuman. Qisman
 * unique indeks, migratsiya 1716000000160 (prod'da takroriy kod bo'lsa
 * migratsiya indeksni yaratmay ogohlantiradi).
 */
@Index('UQ_DISTRICT_SATO_CODE_LIVE', ['sato_code'], {
  unique: true,
  where: `"sato_code" IS NOT NULL AND "sato_code" <> '' AND "is_deleted" = false`,
})
export class District extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Rasmiy SOATO kodi. `null` — NOMA'LUM.
   *
   * Nullable ATAYLAB: avval ustun NOT NULL edi va shu sabab seed soxta kod
   * (`REG-01-DIS-01`) yasashga majbur bo'lardi. Soxta kod haqiqiydek
   * ko'rinib, hamkor tizimlar bilan moslashni jimgina buzardi.
   */
  @Column({ type: 'varchar', nullable: true })
  sato_code!: string | null;

  @Column({ type: 'bigint' })
  region_id!: string;

  @Column({ type: 'bigint', nullable: true })
  assigned_region!: string | null;

  /**
   * Tuman ↔ filial qamrovi — tumanga xizmat qiladigan filial (branch-service
   * filial id; boshqa sxema, FK yo'q). `null` — filial biriktirilmagan:
   * qamrov tumanning xizmat viloyati bo'yicha (`isOrderServedByBranch`).
   * Faqat `logistics.district.set_serving_branch` / `clear_serving_branch`
   * yozadi; viloyat biriktiruvi o'zgarsa (`updateDistrict`) bo'shatiladi.
   * Migratsiya 1716000000200.
   */
  @Column({ type: 'bigint', nullable: true })
  serving_branch_id!: string | null;

  /**
   * D1: filial AVTOMATIK biriktirilgan, ops hali tasdiqlamagan — «Hududlar»
   * sahifasida superadmin/admin ogohlantirish ko'radi. Tasdiq
   * (`confirm_assignment`) yoki qayta biriktirish (`set_serving_branch`)
   * tushiradi. Migratsiya 1716000000227.
   */
  @Column({ type: 'boolean', default: false })
  assignment_review_required!: boolean;

  /** `auto_assigned_D1` | `no_branch_found` — belgi tushgach ham saqlanadi. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  assignment_review_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignment_flagged_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  assignment_confirmed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignment_confirmed_at!: Date | null;

  @ManyToOne(() => Region, (region) => region.districts, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'region_id' })
  region!: Region;

  @ManyToOne(() => Region, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_region' })
  assignedToRegion!: Region | null;
}
